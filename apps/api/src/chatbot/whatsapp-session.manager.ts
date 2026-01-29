/**
 * WhatsApp Session Manager
 * 
 * Gerencia múltiplas sessões de WhatsApp, uma por workspace.
 * Usa whatsapp-web.js para conexão via QR Code (WhatsApp Web).
 * 
 * Responsabilidades:
 * - Criar/destruir sessões por workspace
 * - Gerar QR Codes
 * - Manter estado de conexão
 * - Isolar sessões completamente entre workspaces
 * 
 * Compatível com Railway (Node.js gerenciado):
 * - Puppeteer configurado para ambientes sem GUI
 * - Usa PUPPETEER_EXECUTABLE_PATH se disponível
 * - Flags de segurança para containers/VMs
 * 
 * @module chatbot
 */

import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Client, LocalAuth, Message } from 'whatsapp-web.js';
import * as path from 'path';
import * as fs from 'fs';
import { execSync } from 'child_process';
import { 
  WhatsAppSessionState, 
  WhatsAppSessionInfo,
  IncomingWhatsAppMessage,
} from './whatsapp.types';

// Callback para mensagens recebidas
export type MessageCallback = (message: IncomingWhatsAppMessage) => Promise<void>;

/**
 * Detecta o caminho do Chromium/Chrome no sistema.
 * Tenta múltiplos caminhos conhecidos em diferentes ambientes.
 * 
 * Ordem de prioridade:
 * 1. PUPPETEER_EXECUTABLE_PATH (env var explícita)
 * 2. /nix/var/nix/profiles/default/bin/chromium (Railway Nixpacks)
 * 3. /usr/bin/chromium (Docker Debian)
 * 4. Outros caminhos conhecidos
 */
function findChromiumExecutable(): string | undefined {
  // Se definido via env var, usa diretamente
  const envPath = process.env.PUPPETEER_EXECUTABLE_PATH;
  if (envPath && fs.existsSync(envPath)) {
    return envPath;
  }

  // Caminhos conhecidos para Chromium/Chrome
  // ORDEM IMPORTA: Railway primeiro, depois outros
  const knownPaths = [
    // Nix (Railway) - PRIORIDADE
    '/nix/var/nix/profiles/default/bin/chromium',
    // Docker Debian
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    // Nix alternativo
    (process.env.HOME || '') + '/.nix-profile/bin/chromium',
    // Outros
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    // Snap
    '/snap/bin/chromium',
    // MacOS
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ];

  for (const chromePath of knownPaths) {
    if (fs.existsSync(chromePath)) {
      return chromePath;
    }
  }

  // Tenta via 'which' como último recurso
  try {
    const whichResult = execSync('which chromium || which chromium-browser || which google-chrome || true', { encoding: 'utf-8' }).trim();
    if (whichResult && fs.existsSync(whichResult)) {
      return whichResult;
    }
  } catch {
    // Ignora erro do which
  }

  // Não encontrou - deixa puppeteer tentar encontrar
  return undefined;
}

/**
 * Configuração do Puppeteer para ambientes gerenciados (Railway, Heroku, etc.)
 * - headless: true (sem GUI)
 * - executablePath: detecta automaticamente o Chromium
 * - args: flags obrigatórias para ambientes sem privilégios root
 */
function getPuppeteerConfig() {
  const executablePath = findChromiumExecutable();
  
  const logger = new Logger('PuppeteerConfig');
  if (executablePath) {
    logger.log(`Chromium encontrado: ${executablePath}`);
  } else {
    logger.warn('Chromium não encontrado em caminhos conhecidos, tentando padrão do Puppeteer');
  }
  
  return {
    headless: true,
    executablePath: executablePath || undefined,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--disable-gpu',
      // '--single-process', // REMOVIDO: causa problemas com whatsapp-web.js
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-default-apps',
      '--disable-sync',
      '--disable-translate',
      '--metrics-recording-only',
      '--mute-audio',
      '--no-default-browser-check',
      '--safebrowsing-disable-auto-update',
    ],
  };
}

interface SessionData {
  client: Client;
  state: WhatsAppSessionState;
  qrCode: string | null;
  connectedPhone: string | null;
  connectedAt: Date | null;
  lastError: string | null;
}

@Injectable()
export class WhatsAppSessionManager implements OnModuleDestroy {
  private readonly logger = new Logger(WhatsAppSessionManager.name);
  
  // Map de sessões: workspaceId -> SessionData
  // CADA workspace tem sua própria sessão isolada
  private sessions = new Map<string, SessionData>();
  
  // Map de telefones conectados: phoneNumber -> workspaceId
  // Garante que um número WhatsApp não seja usado em múltiplos workspaces
  private connectedPhones = new Map<string, string>();
  
  // Callback global para mensagens (set pelo BotService)
  private messageCallback: MessageCallback | null = null;
  
  // Set para evitar processar mesma mensagem duas vezes
  // (quando ambos eventos 'message' e 'message_create' disparam)
  private processedMessages = new Set<string>();
  
  // Pasta base para armazenar sessões WhatsApp
  // WHATSAPP_SESSIONS_DIR: diretório configurável via env
  // Fallback: pasta local para Railway/dev (.whatsapp-sessions)
  private readonly sessionsDir: string;

  constructor() {
    // Determinar diretório de sessões
    // Railway: usa .whatsapp-sessions na pasta do app (não há volume persistente)
    // Fly.io/Docker: pode usar WHATSAPP_SESSIONS_DIR=/data/whatsapp (com volume)
    const envSessionsDir = process.env.WHATSAPP_SESSIONS_DIR;
    
    // Só usa envSessionsDir se o diretório pai existir E for gravável
    let useEnvDir = false;
    if (envSessionsDir) {
      const parentDir = path.dirname(envSessionsDir);
      try {
        if (fs.existsSync(parentDir)) {
          // Testa se é gravável criando um arquivo temporário
          const testFile = path.join(parentDir, '.write-test-' + Date.now());
          fs.writeFileSync(testFile, 'test');
          fs.unlinkSync(testFile);
          useEnvDir = true;
        }
      } catch {
        // Diretório não existe ou não é gravável
        this.logger.warn(`[INIT] WHATSAPP_SESSIONS_DIR=${envSessionsDir} não é utilizável, usando fallback`);
      }
    }
    
    if (useEnvDir && envSessionsDir) {
      this.sessionsDir = envSessionsDir;
    } else {
      // Fallback: pasta local relativa ao app
      this.sessionsDir = path.join(process.cwd(), '.whatsapp-sessions');
    }
    
    // Garantir que a pasta de sessões existe
    if (!fs.existsSync(this.sessionsDir)) {
      fs.mkdirSync(this.sessionsDir, { recursive: true });
    }
    
    // Log de inicialização com ID da instância para debug
    this.logger.log(
      `[INIT] SessionManager criado | ` +
      `sessionsDir: ${this.sessionsDir} | ` +
      `env WHATSAPP_SESSIONS_DIR: ${envSessionsDir || '(não definido)'}`
    );
  }

  /**
   * Cleanup ao desligar o módulo
   */
  async onModuleDestroy() {
    this.logger.log('Encerrando todas as sessões WhatsApp...');
    
    const destroyPromises = Array.from(this.sessions.keys()).map(workspaceId => 
      this.destroySession(workspaceId).catch(() => {})
    );
    
    await Promise.all(destroyPromises);
  }

  /**
   * Registra callback para mensagens recebidas
   */
  setMessageCallback(callback: MessageCallback): void {
    this.messageCallback = callback;
    this.logger.log(`[CALLBACK] ✅ messageCallback registrado pelo BotService`);
  }

  /**
   * Retorna informações da sessão
   * SEMPRE retorna dados específicos do workspace solicitado
   */
  getSessionInfo(workspaceId: string): WhatsAppSessionInfo {
    const session = this.sessions.get(workspaceId);
    
    // Log para debug de isolamento
    this.logger.debug(
      `[${workspaceId}] getSessionInfo() | ` +
      `sessões ativas: ${this.sessions.size} | ` +
      `workspaces: [${Array.from(this.sessions.keys()).join(', ')}]`
    );
    
    if (!session) {
      return {
        workspaceId,
        state: WhatsAppSessionState.DISCONNECTED,
        qrCode: null,
        connectedPhone: null,
        connectedAt: null,
        lastError: null,
      };
    }

    return {
      workspaceId,
      state: session.state,
      qrCode: session.qrCode,
      connectedPhone: session.connectedPhone,
      connectedAt: session.connectedAt,
      lastError: session.lastError,
    };
  }

  /**
   * Inicia uma nova sessão para o workspace
   * Se já existir uma sessão conectada, retorna ela
   * CADA WORKSPACE tem seu próprio client isolado
   */
  async startSession(workspaceId: string): Promise<WhatsAppSessionInfo> {
    this.logger.log(
      `[${workspaceId}] startSession() chamado | ` +
      `sessões existentes: ${this.sessions.size} | ` +
      `workspaces: [${Array.from(this.sessions.keys()).join(', ')}]`
    );
    
    const existing = this.sessions.get(workspaceId);
    
    // Se já está conectado ou conectando, retorna
    if (existing && (
      existing.state === WhatsAppSessionState.CONNECTED ||
      existing.state === WhatsAppSessionState.CONNECTING ||
      existing.state === WhatsAppSessionState.QR_PENDING
    )) {
      this.logger.log(`[${workspaceId}] Sessão já existe (${existing.state}) - retornando existente`);
      return this.getSessionInfo(workspaceId);
    }

    // Limpar sessão anterior se existir
    if (existing) {
      this.logger.log(`[${workspaceId}] Limpando sessão anterior...`);
      await this.destroySession(workspaceId);
    }

    this.logger.log(`[${workspaceId}] 🔄 Criando NOVA sessão WhatsApp (cliente isolado)...`);

    // Criar cliente com autenticação local (persistente)
    // IMPORTANTE: clientId = workspaceId garante isolamento de dados
    const client = new Client({
      authStrategy: new LocalAuth({
        clientId: workspaceId,
        dataPath: this.sessionsDir,
      }),
      puppeteer: getPuppeteerConfig(),
    });

    // Criar registro da sessão
    const sessionData: SessionData = {
      client,
      state: WhatsAppSessionState.CONNECTING,
      qrCode: null,
      connectedPhone: null,
      connectedAt: null,
      lastError: null,
    };

    this.sessions.set(workspaceId, sessionData);
    
    this.logger.log(
      `[${workspaceId}] Sessão registrada no Map | ` +
      `total de sessões: ${this.sessions.size}`
    );

    // Configurar event handlers
    this.setupClientEvents(workspaceId, client, sessionData);

    // Inicializar cliente (não bloqueia)
    this.logger.log(`[${workspaceId}] 🚀 Iniciando client.initialize()...`);
    client.initialize()
      .then(async () => {
        this.logger.log(`[${workspaceId}] ✅ client.initialize() completou`);
        
        // Capturar erros do Puppeteer para diagnóstico
        try {
          const page = (client as any).pupPage;
          if (page) {
            page.on('console', (consoleMsg: any) => {
              const type = consoleMsg.type();
              const text = consoleMsg.text();
              // Só logar erros e warnings
              if (type === 'error' || type === 'warning') {
                this.logger.warn(`[${workspaceId}] 🌐 Console[${type}]: ${text.substring(0, 200)}`);
              }
            });
            page.on('pageerror', (err: any) => {
              this.logger.error(`[${workspaceId}] 🌐 PageError: ${err.message?.substring(0, 200) || err}`);
            });
            this.logger.log(`[${workspaceId}] 🔍 Listeners de console do Puppeteer configurados`);
          }
        } catch (e) {
          this.logger.debug(`[${workspaceId}] Não foi possível configurar listeners de página`);
        }
      })
      .catch(err => {
        this.logger.error(`[${workspaceId}] ❌ Erro ao inicializar: ${err.message}`);
        this.logger.error(`[${workspaceId}] Stack: ${err.stack}`);
        sessionData.state = WhatsAppSessionState.AUTH_FAILURE;
        sessionData.lastError = err.message;
      });

    return this.getSessionInfo(workspaceId);
  }

  /**
   * Configura os event handlers do cliente
   */
  private setupClientEvents(workspaceId: string, client: Client, sessionData: SessionData): void {
    this.logger.log(`[${workspaceId}] 🔧 Configurando event handlers...`);
    
    // LOG: Todos os eventos para diagnóstico
    const allEvents = ['qr', 'authenticated', 'auth_failure', 'ready', 'message', 'message_create', 
      'disconnected', 'loading_screen', 'change_state', 'change_battery'];
    allEvents.forEach(evt => {
      this.logger.debug(`[${workspaceId}] Registrando listener para: ${evt}`);
    });
    
    // QR Code gerado
    client.on('qr', (qr: string) => {
      this.logger.log(`[${workspaceId}] QR Code gerado`);
      sessionData.state = WhatsAppSessionState.QR_PENDING;
      sessionData.qrCode = qr;
    });

    // Log de loading_screen (pode ajudar a entender o que está acontecendo)
    client.on('loading_screen', (percent: number, message: string) => {
      this.logger.log(`[${workspaceId}] 📊 Loading: ${percent}% - ${message}`);
    });
    
    // Mudança de estado interno do WhatsApp
    client.on('change_state', (state: string) => {
      this.logger.log(`[${workspaceId}] 🔄 Estado mudou para: ${state}`);
    });

    // Autenticação bem sucedida
    client.on('authenticated', () => {
      this.logger.log(`[${workspaceId}] ✅ Autenticado com sucesso - aguardando ready...`);
      sessionData.state = WhatsAppSessionState.AUTHENTICATING;
      sessionData.qrCode = null;
      
      // Fallback: detectar ready manualmente se evento não vier
      // (whatsapp-web.js pode ter seletores desatualizados)
      const readyCheckInterval = setInterval(async () => {
        // Se já está conectado (ready disparou), para
        if (sessionData.state === WhatsAppSessionState.CONNECTED) {
          clearInterval(readyCheckInterval);
          return;
        }
        
        try {
          const page = (client as any).pupPage;
          if (!page) return;
          
          // Verificar se a interface principal do WhatsApp carregou
          const isReady = await page.evaluate(() => {
            // Múltiplos seletores para detectar interface pronta
            const hasSearchBox = !!document.querySelector('[data-testid="chat-list-search"]') ||
                                 !!document.querySelector('[title="Pesquisar"]') ||
                                 !!document.querySelector('[title="Search"]') ||
                                 !!document.querySelector('div[contenteditable="true"][data-tab]');
            const hasMainPane = !!document.querySelector('#pane-side') ||
                               !!document.querySelector('[data-testid="conversation-panel-wrapper"]');
            const bodyText = document.body?.innerText || '';
            const hasConversationUI = bodyText.includes('Pesquisar ou iniciar') || 
                                      bodyText.includes('Search or start') ||
                                      bodyText.includes('Todas') ||
                                      bodyText.includes('Não lidas');
            return hasSearchBox || hasMainPane || hasConversationUI;
          }).catch(() => false);
          
          if (isReady) {
            this.logger.log(`[${workspaceId}] 🔧 Ready detectado manualmente (fallback) - disparando ready...`);
            clearInterval(readyCheckInterval);
            
            // Simular o evento ready
            sessionData.state = WhatsAppSessionState.CONNECTED;
            sessionData.connectedAt = new Date();
            
            // Tentar obter número conectado
            try {
              const info = client.info;
              if (info?.wid?.user) {
                const phoneNumber = info.wid.user;
                sessionData.connectedPhone = `+${phoneNumber}`;
                
                // Verificar conflito
                const existingWorkspace = this.connectedPhones.get(phoneNumber);
                if (existingWorkspace && existingWorkspace !== workspaceId) {
                  this.logger.error(`[${workspaceId}] ⚠️ CONFLITO: Número ${phoneNumber} já conectado no workspace ${existingWorkspace}`);
                  sessionData.state = WhatsAppSessionState.AUTH_FAILURE;
                  sessionData.lastError = `Número já em uso pelo workspace ${existingWorkspace}`;
                  await client.logout().catch(() => {});
                  return;
                }
                
                this.connectedPhones.set(phoneNumber, workspaceId);
                this.logger.log(`[${workspaceId}] ✅ WhatsApp conectado (fallback) | telefone: +${phoneNumber}`);
              } else {
                this.logger.log(`[${workspaceId}] ✅ WhatsApp conectado (fallback)`);
              }
            } catch {
              this.logger.log(`[${workspaceId}] ✅ WhatsApp conectado (fallback)`);
            }
          }
        } catch (e) {
          // Ignore
        }
      }, 3000); // Verificar a cada 3 segundos
      
      // Limpar após 2 minutos
      setTimeout(() => clearInterval(readyCheckInterval), 120000);
    });

    // Pronto para usar
    client.on('ready', async () => {
      this.logger.log(`[${workspaceId}] 🎉 Evento READY recebido!`);
      sessionData.state = WhatsAppSessionState.CONNECTED;
      sessionData.qrCode = null;
      sessionData.connectedAt = new Date();
      
      // Obter número conectado
      try {
        const info = client.info;
        if (info?.wid?.user) {
          const phoneNumber = info.wid.user;
          sessionData.connectedPhone = `+${phoneNumber}`;
          
          // Verificar se este número já está em uso por outro workspace
          const existingWorkspace = this.connectedPhones.get(phoneNumber);
          if (existingWorkspace && existingWorkspace !== workspaceId) {
            this.logger.error(
              `[${workspaceId}] ⚠️ CONFLITO: Número ${phoneNumber} já conectado no workspace ${existingWorkspace}`
            );
            // Desconecta esta sessão para evitar conflito
            sessionData.state = WhatsAppSessionState.AUTH_FAILURE;
            sessionData.lastError = `Número já em uso pelo workspace ${existingWorkspace}`;
            await client.logout().catch(() => {});
            return;
          }
          
          // Registrar número como em uso por este workspace
          this.connectedPhones.set(phoneNumber, workspaceId);
          
          this.logger.log(
            `[${workspaceId}] ✅ WhatsApp conectado e pronto | ` +
            `telefone: +${phoneNumber} | ` +
            `sessões ativas: ${this.sessions.size}`
          );
        } else {
          this.logger.log(`[${workspaceId}] ✅ WhatsApp conectado e pronto`);
        }
      } catch {
        this.logger.log(`[${workspaceId}] ✅ WhatsApp conectado e pronto`);
      }
    });

    // Desconectado
    client.on('disconnected', (reason: string) => {
      this.logger.warn(`[${workspaceId}] Desconectado: ${reason}`);
      
      // Remover número do registro de telefones conectados
      if (sessionData.connectedPhone) {
        const phoneNumber = sessionData.connectedPhone.replace('+', '');
        this.connectedPhones.delete(phoneNumber);
      }
      
      sessionData.state = WhatsAppSessionState.DISCONNECTED;
      sessionData.connectedPhone = null;
      sessionData.connectedAt = null;
      sessionData.lastError = reason;
    });

    // Falha na autenticação
    client.on('auth_failure', (msg: string) => {
      this.logger.error(`[${workspaceId}] Falha na autenticação: ${msg}`);
      sessionData.state = WhatsAppSessionState.AUTH_FAILURE;
      sessionData.lastError = msg;
      sessionData.qrCode = null;
    });

    // Handler compartilhado para mensagens
    const handleMessage = async (msg: Message, eventName: string) => {
      const messageId = msg.id._serialized;
      
      // Evitar processar mesma mensagem duas vezes
      if (this.processedMessages.has(messageId)) {
        this.logger.debug(`[${workspaceId}] Mensagem ${messageId} já processada, ignorando duplicata`);
        return;
      }
      this.processedMessages.add(messageId);
      
      // Limpar mensagens antigas do set (evitar memory leak)
      if (this.processedMessages.size > 1000) {
        const arr = Array.from(this.processedMessages);
        arr.slice(0, 500).forEach(id => this.processedMessages.delete(id));
      }
      
      // LOG: Mensagem bruta recebida
      this.logger.log(
        `[${workspaceId}] 📩 ${eventName} | ` +
        `from: ${msg.from} | ` +
        `body: "${(msg.body || '').substring(0, 50)}" | ` +
        `fromMe: ${msg.fromMe} | ` +
        `callback: ${!!this.messageCallback}`
      );
      
      // Ignorar mensagens de grupo, próprias, de broadcast ou LID
      if (
        msg.from.includes('@g.us') ||       // Grupos
        msg.from.includes('@broadcast') ||  // Broadcast
        msg.from.includes('@lid') ||        // LID (identificador interno)
        msg.fromMe                          // Mensagens próprias
      ) {
        this.logger.debug(`[${workspaceId}] Mensagem ignorada: grupo/broadcast/própria`);
        return;
      }

      // Ignorar mensagens vazias ou muito antigas (sync inicial)
      const messageAge = Date.now() - (msg.timestamp * 1000);
      if (!msg.body || msg.body.trim() === '' || messageAge > 60000) {
        this.logger.debug(`[${workspaceId}] Mensagem ignorada: vazia ou antiga (${messageAge}ms)`);
        return; // Ignora mensagens vazias ou com mais de 1 minuto
      }

      // Obter nome do contato
      let fromName = '';
      try {
        const contact = await msg.getContact();
        fromName = contact?.pushname || contact?.name || '';
      } catch {
        // Ignora erro ao obter contato
      }

      // Converter para formato interno
      const incoming: IncomingWhatsAppMessage = {
        workspaceId,
        from: msg.from.replace('@c.us', ''),
        fromName,
        body: msg.body || '',
        timestamp: new Date(msg.timestamp * 1000),
        messageId: msg.id._serialized,
        rawMessage: msg, // Passar mensagem original para reply
      };

      // Chamar callback se registrado
      if (this.messageCallback) {
        this.logger.log(`[${workspaceId}] 📤 Chamando callback do bot para: ${msg.from}`);
        try {
          await this.messageCallback(incoming);
          this.logger.log(`[${workspaceId}] ✅ Callback processou mensagem com sucesso`);
        } catch (err) {
          this.logger.error(`[${workspaceId}] ❌ Erro no callback de mensagem: ${err}`);
        }
      } else {
        this.logger.warn(`[${workspaceId}] ⚠️ messageCallback NÃO registrado - mensagem não será processada!`);
      }
    };

    // Registra ambos os eventos para maior compatibilidade
    // Em algumas versões do whatsapp-web.js, apenas 'message_create' dispara
    client.on('message', (msg: Message) => handleMessage(msg, 'message'));
    client.on('message_create', (msg: Message) => {
      // message_create dispara para TODAS as mensagens (enviadas e recebidas)
      // Só processa se NÃO for mensagem própria (evita duplicação com 'message')
      if (!msg.fromMe) {
        handleMessage(msg, 'message_create');
      }
    });
  }

  /**
   * Responde diretamente a uma mensagem
   * Usa window.WWebJS.sendMessage diretamente via pupPage.evaluate
   * para contornar o bug do markedUnread no whatsapp-web.js
   */
  async replyToMessage(workspaceId: string, rawMessage: unknown, text: string): Promise<boolean> {
    const session = this.sessions.get(workspaceId);
    
    if (!session || session.state !== WhatsAppSessionState.CONNECTED) {
      this.logger.warn(`[${workspaceId}] Tentativa de responder sem sessão conectada`);
      return false;
    }

    try {
      const msg = rawMessage as Message;
      const chatId = msg.from;
      
      // Acessa pupPage do cliente
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pupPage = (session.client as any).pupPage;
      
      if (!pupPage) {
        this.logger.error(`[${workspaceId}] pupPage não disponível`);
        return false;
      }
      
      // Usa window.WWebJS.sendMessage diretamente
      // Esta é a função interna que contorna o bug do markedUnread
      const result = await pupPage.evaluate(async (chatId: string, content: string) => {
        try {
          // Busca o chat sem serialização (getAsModel: false)
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const win = window as any;
          const chat = await win.WWebJS.getChat(chatId, { getAsModel: false });
          
          if (!chat) {
            return { success: false, error: 'Chat não encontrado' };
          }
          
          // Usa sendMessage interno do WWebJS
          const msg = await win.WWebJS.sendMessage(chat, content, {});
          return { success: !!msg, error: null };
        } catch (err: unknown) {
          return { success: false, error: String(err) };
        }
      }, chatId, text);
      
      if (result.success) {
        this.logger.log(`[${workspaceId}] Resposta enviada para ${chatId}`);
        return true;
      }
      
      this.logger.warn(`[${workspaceId}] Falha ao enviar: ${result.error}`);
      return false;
    } catch (err) {
      this.logger.error(`[${workspaceId}] Erro ao responder mensagem: ${err}`);
      return false;
    }
  }

  /**
   * Envia mensagem de texto para qualquer número (mesmo sem conversa prévia)
   * Usa pupPage.evaluate com WWebJS.sendMessage (contorna bug do markedUnread)
   */
  async sendMessage(workspaceId: string, to: string, text: string): Promise<boolean> {
    const session = this.sessions.get(workspaceId);
    
    if (!session || session.state !== WhatsAppSessionState.CONNECTED) {
      this.logger.warn(`[${workspaceId}] Tentativa de enviar mensagem sem sessão conectada (state: ${session?.state})`);
      return false;
    }

    try {
      // Formatar número para WhatsApp (adiciona @c.us)
      const chatId = this.formatPhoneForWhatsApp(to);
      this.logger.log(`[${workspaceId}] sendMessage: ${to} -> ${chatId}`);
      
      // Acessa pupPage do cliente
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pupPage = (session.client as any).pupPage;
      
      if (!pupPage) {
        this.logger.error(`[${workspaceId}] pupPage não disponível`);
        return false;
      }
      
      // Usa window.WWebJS.sendMessage diretamente (contorna bug do markedUnread)
      // COPIA EXATA do replyToMessage que funciona
      const result = await pupPage.evaluate(async (chatId: string, content: string) => {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const win = window as any;
          
          // Busca o chat sem serialização (getAsModel: false) - mesmo que replyToMessage
          const chat = await win.WWebJS.getChat(chatId, { getAsModel: false });
          
          if (!chat) {
            return { success: false, error: 'Chat não encontrado' };
          }
          
          // Usa sendMessage interno do WWebJS
          const msg = await win.WWebJS.sendMessage(chat, content, {});
          return { success: !!msg, error: null };
        } catch (err: unknown) {
          return { success: false, error: String(err) };
        }
      }, chatId, text);
      
      if (result.success) {
        this.logger.log(`[${workspaceId}] ✅ Mensagem enviada para ${to}`);
        return true;
      }
      
      this.logger.warn(`[${workspaceId}] ⚠️ Falha ao enviar para ${to}: ${result.error}`);
      return false;
    } catch (err) {
      this.logger.error(`[${workspaceId}] ❌ Erro ao enviar mensagem para ${to}: ${err}`);
      return false;
    }
  }

  /**
   * Formata telefone para o formato do WhatsApp
   */
  private formatPhoneForWhatsApp(phone: string): string {
    // Remove caracteres não numéricos
    let cleaned = phone.replace(/\D/g, '');
    
    // Remove o + do início se existir
    if (cleaned.startsWith('+')) {
      cleaned = cleaned.slice(1);
    }
    
    // Adiciona 55 se não tiver código do país
    if (!cleaned.startsWith('55') && cleaned.length <= 11) {
      cleaned = '55' + cleaned;
    }
    
    return `${cleaned}@c.us`;
  }

  /**
   * Destrói uma sessão
   * Remove APENAS a sessão do workspace especificado
   */
  async destroySession(workspaceId: string): Promise<void> {
    const session = this.sessions.get(workspaceId);
    
    if (!session) {
      this.logger.debug(`[${workspaceId}] destroySession() - sessão não existe`);
      return;
    }

    this.logger.log(
      `[${workspaceId}] 🗑️ Destruindo sessão | ` +
      `telefone: ${session.connectedPhone || 'N/A'} | ` +
      `sessões antes: ${this.sessions.size}`
    );
    
    // Remover número do registro
    if (session.connectedPhone) {
      const phoneNumber = session.connectedPhone.replace('+', '');
      this.connectedPhones.delete(phoneNumber);
    }

    try {
      await session.client.destroy();
    } catch (err) {
      this.logger.warn(`[${workspaceId}] Erro ao destruir cliente: ${err}`);
    }

    this.sessions.delete(workspaceId);
    
    this.logger.log(
      `[${workspaceId}] ✅ Sessão destruída | ` +
      `sessões restantes: ${this.sessions.size} | ` +
      `workspaces: [${Array.from(this.sessions.keys()).join(', ')}]`
    );
  }

  /**
   * Desconecta e remove dados da sessão
   * Remove APENAS a sessão do workspace especificado
   */
  async logoutSession(workspaceId: string): Promise<void> {
    const session = this.sessions.get(workspaceId);
    
    if (!session) {
      this.logger.debug(`[${workspaceId}] logoutSession() - sessão não existe`);
      return;
    }

    this.logger.log(
      `[${workspaceId}] 🚪 Fazendo logout | ` +
      `telefone: ${session.connectedPhone || 'N/A'}`
    );

    try {
      await session.client.logout();
    } catch {
      // Ignora erro no logout
    }

    await this.destroySession(workspaceId);

    // Remover pasta de sessão
    const sessionPath = path.join(this.sessionsDir, `session-${workspaceId}`);
    if (fs.existsSync(sessionPath)) {
      fs.rmSync(sessionPath, { recursive: true, force: true });
      this.logger.log(`[${workspaceId}] Pasta de sessão removida`);
    }
  }

  /**
   * Verifica se workspace está conectado
   */
  isConnected(workspaceId: string): boolean {
    const session = this.sessions.get(workspaceId);
    return session?.state === WhatsAppSessionState.CONNECTED;
  }

  /**
   * Retorna todos os workspaces com sessão ativa
   */
  getActiveWorkspaces(): string[] {
    return Array.from(this.sessions.keys());
  }
  
  /**
   * Debug: Retorna estado completo de todas as sessões
   */
  getDebugInfo(): { sessions: string[]; phones: Record<string, string> } {
    return {
      sessions: Array.from(this.sessions.keys()),
      phones: Object.fromEntries(this.connectedPhones),
    };
  }
}

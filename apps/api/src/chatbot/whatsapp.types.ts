/**
 * WhatsApp Types
 * 
 * Tipos para o bot de WhatsApp via whatsapp-web.js.
 * 
 * @module chatbot
 */

// ==========================================================================
// SESSION STATES
// ==========================================================================

export enum WhatsAppSessionState {
  DISCONNECTED = 'disconnected',
  CONNECTING = 'connecting',
  QR_PENDING = 'qr_pending',
  AUTHENTICATING = 'authenticating',
  CONNECTED = 'connected',
  AUTH_FAILURE = 'auth_failure',
}

// ==========================================================================
// SESSION INFO
// ==========================================================================

export interface WhatsAppSessionInfo {
  workspaceId: string;
  state: WhatsAppSessionState;
  qrCode: string | null;
  connectedPhone: string | null;
  connectedAt: Date | null;
  lastError: string | null;
}

// ==========================================================================
// API RESPONSES
// ==========================================================================

export interface WhatsAppStatusResponse {
  success: boolean;
  data: {
    state: WhatsAppSessionState;
    connectedPhone: string | null;
    connectedAt: string | null;
    qrCode: string | null;
  };
}

export interface WhatsAppQrCodeResponse {
  success: boolean;
  data: {
    qrCode: string | null;
    state: WhatsAppSessionState;
  } | null;
  error?: string;
}

export interface WhatsAppConnectResponse {
  success: boolean;
  message: string;
  data?: {
    state: WhatsAppSessionState;
    qrCode: string | null;
  };
}

export interface WhatsAppDisconnectResponse {
  success: boolean;
  message: string;
}

// ==========================================================================
// INCOMING MESSAGE
// ==========================================================================

export interface IncomingWhatsAppMessage {
  workspaceId: string;
  from: string;        // Telefone E.164
  fromName: string;    // Nome do contato
  body: string;        // Texto da mensagem
  timestamp: Date;
  messageId: string;
  rawMessage?: unknown; // Mensagem original (para reply direto)
}

// ==========================================================================
// BOT CONTEXT (para handlers)
// ==========================================================================

export interface BotMessageContext {
  workspaceId: string;
  clientPhone: string;
  clientName: string;
  messageText: string;
}

// ==========================================================================
// TEMPLATE VARIABLES
// ==========================================================================

export interface TemplateVariables {
  clientName?: string;
  serviceName?: string;
  date?: string;
  time?: string;
  workspaceName?: string;
  [key: string]: string | undefined;
}

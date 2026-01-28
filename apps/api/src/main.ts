import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { Logger } from '@nestjs/common';

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule);

  // Configuração CORS robusta
  const corsOriginsRaw = process.env.CORS_ORIGINS ?? process.env.CORS_ORIGIN ?? '';
  const allowedOrigins = corsOriginsRaw
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  logger.log(`CORS configurado. Origins explícitas: ${allowedOrigins.length > 0 ? allowedOrigins.join(', ') : '(nenhuma - aceita .railway.app e localhost)'}`);

  app.enableCors({
    origin: (origin, callback) => {
      // Requisições sem origin (server-to-server, Postman, etc.)
      if (!origin) {
        return callback(null, true);
      }

      // Se há origins explícitas configuradas, usa elas
      if (allowedOrigins.length > 0) {
        const allowed = allowedOrigins.includes(origin);
        if (!allowed) {
          logger.warn(`CORS bloqueado para origin: ${origin}`);
        }
        return callback(null, allowed);
      }

      // Fallback: aceita localhost e subdomínios de plataformas conhecidas
      const isLocalhost = origin.includes('localhost') || origin.includes('127.0.0.1');
      const isRailway = origin.endsWith('.railway.app');
      const allowed = isLocalhost || isRailway;
      
      if (!allowed) {
        logger.warn(`CORS bloqueado para origin: ${origin}`);
      }
      
      return callback(null, allowed);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'Origin', 'X-Requested-With'],
  });

  const portRaw = process.env.PORT ?? process.env.API_PORT ?? '3000';
  const port = Number(portRaw);
  await app.listen(Number.isFinite(port) ? port : 3000);
  
  logger.log(`🚀 API rodando na porta ${port}`);
}
bootstrap();

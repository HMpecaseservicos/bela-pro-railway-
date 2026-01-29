import { Injectable, OnModuleDestroy, OnModuleInit, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy, OnModuleInit {
  private readonly logger = new Logger(PrismaService.name);

  async onModuleInit() {
    this.logger.log('Conectando ao banco de dados...');
    try {
      await this.$connect();
      this.logger.log('✅ Conexão com banco de dados estabelecida');
    } catch (error) {
      this.logger.error('❌ Erro ao conectar ao banco:', error);
      throw error;
    }
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}

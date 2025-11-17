import { ITransport } from "../../infrastructure/transport/ITransport.js";
import { contextLogger as logger } from "../../infrastructure/http/Logger.js";

export class ServerManager {
  private isShuttingDown: boolean = false;
  
  constructor(private transport: ITransport) {}

  async start(): Promise<void> {
    try {
      await this.transport.start();
      logger.info('Server started successfully');
    } catch (error) {
      logger.error('Failed to start server', error);
      throw error;
    }
  }

  async stop(): Promise<void> {
    try {
      await this.transport.stop();
      logger.info('Server stopped successfully');
    } catch (error) {
      logger.error('Error stopping server', error);
      throw error;
    }
  }

  // Handle graceful shutdown
  setupGracefulShutdown(): void {
    const signals = ['SIGINT', 'SIGTERM', 'SIGUSR2'];
    
    signals.forEach(signal => {
      process.on(signal, async () => {
        // Prevent multiple concurrent shutdown attempts
        if (this.isShuttingDown) {
          return;
        }
        this.isShuttingDown = true;
        
        logger.info(`Received ${signal}, shutting down gracefully...`);
        
        // Set a force-shutdown timeout (5 seconds)
        const forceShutdownTimeout = setTimeout(() => {
          logger.warn('Graceful shutdown timed out, forcing exit');
          process.exit(1);
        }, 5000);
        
        try {
          await this.stop();
          clearTimeout(forceShutdownTimeout);
          process.exit(0);
        } catch (error) {
          clearTimeout(forceShutdownTimeout);
          logger.error('Error during shutdown', error);
          process.exit(1);
        }
      });
    });
  }
}
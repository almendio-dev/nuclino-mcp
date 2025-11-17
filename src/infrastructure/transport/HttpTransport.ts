import express from "express";
import cors from "cors";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { ITransport, TransportConfig } from "./ITransport.js";
import { logger } from "../http/Logger.js";
import { NuclinoRepository } from "../nuclino/NuclinoRepository.js";
import { RateLimiter } from "../nuclino/RateLimiter.js";
import { RetryHandler } from "../nuclino/RetryHandler.js";
import { NuclinoMcpServer } from "../../presentation/McpServer.js";

export class HttpTransport implements ITransport {
  private app: express.Application;
  private server: any;
  private transports: Map<string, SSEServerTransport> = new Map();
  private mcpAuthKey?: string;

  constructor(private config: TransportConfig) {
    this.app = express();
    
    // Load MCP auth key from environment (optional)
    this.mcpAuthKey = process.env.MCP_AUTH_KEY;
    
    // Log authentication status
    if (this.mcpAuthKey) {
      logger.info('MCP authentication is enabled');
    } else {
      logger.info('MCP authentication is disabled');
    }
    
    // Configure CORS to allow all origins
    const corsOptions = {
      origin: '*',
      methods: ['GET', 'POST', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'X-MCP-Auth-Key'],
      credentials: false
    };
    this.app.use(cors(corsOptions));
    
    this.app.use(express.json());
    this.setupRoutes();
  }

  private setupRoutes() {
    // Health check endpoint (no authentication required)
    this.app.get('/health', (req, res) => {
      res.status(200).json({
        status: 'ok',
        server: 'nuclino-mcp',
        version: '1.0.0',
        activeSessions: this.transports.size,
        timestamp: new Date().toISOString()
      });
    });

    // Handle GET requests to establish MCP connection via SSE
    this.app.get('/mcp', async (req, res) => {
      logger.info('Received GET request to /mcp (establishing MCP connection)');
      
      try {
        // Validate Nuclino API key
        const nuclinoApiKey = this.config.apiKey;
        if (!nuclinoApiKey) {
          logger.error('Nuclino API key not configured');
          res.status(500).send('Server configuration error: Nuclino API key not set');
          return;
        }

        // Create a new SSE transport for the client
        // The endpoint for POST messages is '/messages'
        const transport = new SSEServerTransport('/messages', res);
        
        // Get the session ID
        const sessionId = transport.sessionId;
        
        // Store the transport by session ID
        this.transports.set(sessionId, transport);
        
        // Set up onclose handler to clean up transport when closed
        transport.onclose = () => {
          logger.info(`MCP transport closed for session ${sessionId}`);
          this.transports.delete(sessionId);
        };
        
        // Set up onerror handler to log errors
        transport.onerror = (error) => {
          logger.error(`MCP transport error for session ${sessionId}:`, error);
        };
        
        // Create and connect the MCP server
        // The server.connect() will call transport.start() which sends SSE headers and initial endpoint event
        const server = this.createMcpServer(nuclinoApiKey);
        await server.connect(transport);
        
        logger.info(`Established MCP connection with session ID: ${sessionId}`);
        
        // Note: Do not send any response here - the SSEServerTransport has taken ownership of the response
        // and will manage it for the duration of the SSE connection
      } catch (error) {
        logger.error('Error establishing SSE stream:', error);
        // Only send error response if headers haven't been sent yet
        if (!res.headersSent) {
          res.status(500).json({ 
            error: 'Failed to establish SSE stream', 
            message: error instanceof Error ? error.message : String(error)
          });
        }
      }
    });

    // Handle POST requests for client messages
    this.app.post('/messages', async (req, res) => {
      logger.info('Received POST request to /messages');
      
      // Check MCP authentication if enabled
      if (this.mcpAuthKey) {
        const authHeader = req.headers['x-mcp-auth-key'] as string | undefined;
        if (!authHeader || authHeader !== this.mcpAuthKey) {
          logger.warn('Unauthorized request: Invalid or missing X-MCP-Auth-Key header');
          res.status(401).json({
            jsonrpc: '2.0',
            error: {
              code: -32001,
              message: 'Unauthorized: Invalid or missing X-MCP-Auth-Key header',
            },
            id: null,
          });
          return;
        }
      }
      
      // Extract session ID from URL query parameter
      const sessionId = req.query.sessionId as string | undefined;
      if (!sessionId) {
        logger.error('No session ID provided in request URL');
        res.status(400).send('Missing sessionId parameter');
        return;
      }
      
      const transport = this.transports.get(sessionId);
      if (!transport) {
        logger.error(`No active transport found for session ID: ${sessionId}`);
        res.status(404).send('Session not found');
        return;
      }
      
      try {
        // Handle the POST message with the transport
        await transport.handlePostMessage(req, res, req.body);
      } catch (error) {
        logger.error('Error handling request:', error);
        if (!res.headersSent) {
          res.status(500).send('Error handling request');
        }
      }
    });
  }

  private createMcpServer(apiKey: string): McpServer {
    // Create dependencies using Clean Architecture
    const rateLimiter = new RateLimiter(150, 1); // 150 requests per minute
    const retryHandler = new RetryHandler({
      maxRetries: 3,
      baseDelay: 1000,
      maxDelay: 30000,
      backoffFactor: 2
    });
    const nuclinoRepository = new NuclinoRepository(apiKey, rateLimiter, retryHandler);

    // Create MCP server with dependencies
    const nuclinoMcpServer = new NuclinoMcpServer(nuclinoRepository);
    return nuclinoMcpServer.getServer();
  }

  async start(): Promise<void> {
    const port = this.config.port || 3000;
    return new Promise((resolve) => {
      this.server = this.app.listen(port, () => {
        logger.info(`Nuclino MCP HTTP server started on port ${port}`);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (this.server) {
      // First, close all active SSE transport connections
      logger.info(`Closing ${this.transports.size} active SSE transport(s)`);
      for (const [sessionId, transport] of this.transports.entries()) {
        try {
          transport.close();
          logger.info(`Closed SSE transport for session ${sessionId}`);
        } catch (error) {
          logger.error(`Error closing SSE transport for session ${sessionId}`, error);
        }
      }
      this.transports.clear();
      
      // Force close all HTTP connections (available in Node.js v18.2.0+)
      if (typeof this.server.closeAllConnections === 'function') {
        this.server.closeAllConnections();
        logger.info('Forced closure of all HTTP connections');
      }
      
      return new Promise((resolve) => {
        this.server.close(() => {
          logger.info('HTTP server stopped');
          resolve();
        });
      });
    }
  }

  async connectServer(server: McpServer): Promise<void> {
    // For HTTP transport, server connection is handled per session
    // This method is not used for HTTP transport
  }
}
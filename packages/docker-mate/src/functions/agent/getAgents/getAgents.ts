import { FastifyReply, FastifyRequest } from 'fastify';
import { GetAgentsHandler } from './getAgents.model';
import { ComposeFile, ComposeService } from '../../../models/composeFile.model';
import readYmlFile from '../../../helpers/readYmlFile/readYmlFile';

/**
 * Get all agents from the Docker Compose file
 * Filters containers with type 'source' or 'target'
 */
export const getAgents: GetAgentsHandler = async (
  request: FastifyRequest,
  reply: FastifyReply
) => {
  try {
    const filename = 'compose.agents.yml';
    // Read the compose file
    const composeFile = await readYmlFile<ComposeFile>(filename);
    
    // Filter services to find agents (containers with type 'source' or 'target')
    const agents = Object.entries(composeFile.services || {})
      .filter(([_, service]: [string, ComposeService]) => {
        // Check if environment contains type=source or type=target
        const envVars = service.environment || [];
        return envVars.some((env: any) => {
          if (typeof env === 'string') {
            return env === 'type=source' || env === 'type=target';
          } else if (typeof env === 'object' && env !== null) {
            const envObj = env as Record<string, string>;
            return envObj.type === 'source' || envObj.type === 'target';
          }
          return false;
        });
      })
      .map(([name, service]: [string, ComposeService]) => {
        // Extract type from environment
        const envVars = service.environment || [];
        let type: 'source' | 'target' = 'source'; // Default
        
        for (const env of envVars) {
          if (typeof env === 'string' && env.startsWith('type=')) {
            type = env.split('=')[1] as 'source' | 'target';
            break;
          } else if (typeof env === 'object' && env !== null) {
            const envObj = env as Record<string, string>;
            if (envObj.type) {
              type = envObj.type as 'source' | 'target';
              break;
            }
          }
        }
        
        return {
          id: name,
          imageName: service.image || '',
          type,
          nickname: name,
          tag: service.image ? service.image.split(':')[1] : undefined,
          environment: service.environment,
          ports: service.ports,
          volumes: service.volumes
        };
      });
    
    reply.send({ success: true, data: agents });
  } catch (error) {
    request.log.error('Error getting agents:', error);
    reply.status(500).send({ 
      success: false, 
      error: error instanceof Error ? error.message : 'Unknown error' 
    });
  }
};

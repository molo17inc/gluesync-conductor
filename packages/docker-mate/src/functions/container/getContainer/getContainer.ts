/**
 * This file is part of Gluesync Container Mate.
 *
 * Gluesync Container Mate is dual-licensed under the following licenses:
 *
 * 1. GNU General Public License (GPL) Version 3
 *    You may use, modify, and distribute this software under the terms of the GPL v3.
 *    This option is available at no cost, but any derivative works must also be licensed under GPL v3.
 *
 * 2. MOLO17 Commercial License
 *    Alternatively, you may use this software under the MOLO17 Commercial License,
 *    which includes a warranty and permits proprietary use. Contact MOLO17 at info@molo17.com
 *    for licensing terms and conditions.
 *
 * Copyright (C) 2025 MOLO17. All rights reserved.
 */

import { GetContainerHandler, ContainerData } from './getContainer.model';
import parseImageTag from '../../../helpers/parseImageTag/parseImageTag';
import readYmlFile from '../../../helpers/readYmlFile/readYmlFile';
import { ComposeFile } from '../../../models/composeFile.model';

const handler: GetContainerHandler = async (req, reply) => {
  try {
    const { id } = req.params;
    
    try {
      // Get the container by ID directly from Docker
      const container = req.server.docker.getContainer(id);
      const details = await container.inspect();
      
      // Get Docker system information (CPU count and total memory)
      const dockerInfo = await req.server.docker.info();
      const systemInfo = {
        ncpu: dockerInfo.NCPU,
        memTotal: dockerInfo.MemTotal
      };
      
      req.log.info(`System info - CPUs: ${systemInfo.ncpu}, Memory: ${systemInfo.memTotal} bytes`);
      
      // Extract image name and tag
      const imageString = details.Config?.Image || '';
      const { name: fullImageName, tag } = parseImageTag(imageString);
      
      // Extract the image name without registry prefix
      let imageName = fullImageName;
      if (fullImageName.includes('/')) {
        imageName = fullImageName.split('/').pop() || '';
      }
      
      // Determine container type based on environment variables or labels
      let type: 'target' | 'source' = 'target';
      const envVars = details.Config?.Env || [];
      for (const env of envVars) {
        if (env.startsWith('type=')) {
          const envType = env.split('=')[1];
          if (envType === 'source' || envType === 'target') {
            type = envType as 'target' | 'source';
            break;
          }
        }
      }
      
      // Extract environment variables (excluding system ones)
      const environment: Record<string, any> = {};
      const systemEnvVars = ['type', 'maxRamPercentage', 'LOG_CONFIG_FILE', 'GLUESYNC_MODULE_TAG'];
      
      for (const env of envVars) {
        const [key, ...valueParts] = env.split('=');
        const value = valueParts.join('='); // Handle values that might contain '='
        
        if (key && !systemEnvVars.includes(key)) {
          environment[key] = value;
        }
      }
      
      // Extract ports
      const ports: string[] = [];
      if (details.HostConfig?.PortBindings) {
        for (const [containerPort, hostBindings] of Object.entries(details.HostConfig.PortBindings)) {
          if (Array.isArray(hostBindings) && hostBindings.length > 0 && hostBindings[0]?.HostPort) {
            const hostPort = hostBindings[0].HostPort;
            ports.push(`${hostPort}:${containerPort}`);
          }
        }
      }
      
      // Extract volumes
      const volumes: string[] = [];
      if (details.HostConfig?.Binds) {
        // Filter out system volumes
        const systemVolumes = [
          './gs-license.dat:/opt/gluesync/data/gs-license.dat:ro',
          './logback.xml:/opt/gluesync/data/logback.xml:ro',
          './security-config.json:/opt/gluesync/data/security-config.json:ro',
          './gluesync.com.jks:/opt/gluesync/data/gluesync.com.jks:ro',
          './bootstrap-core-hub.json:/opt/gluesync/data/bootstrap-core-hub.json:ro'
        ];
        
        for (const bind of details.HostConfig.Binds) {
          if (!systemVolumes.some(sv => bind.includes(sv))) {
            volumes.push(bind);
          }
        }
      }
      
      // Check if this container is persisted in the compose file
      let persisted = false;
      let versionTagFromLabel = null;
      
      try {
        const composeFile = await readYmlFile<ComposeFile>('compose.agents.yml');
        
        // Get labels
        const labels = details.Config?.Labels || {};
        
        // Check for unique ID label
        const uniqueIdLabel = Object.entries(labels).find(
          ([key]) => key === 'com.molo17.conductor.unique_id'
        );
        
        // Check for version tag label
        const versionTagLabel = Object.entries(labels).find(
          ([key]) => key === 'com.molo17.conductor.versiontag'
        );
        
        if (versionTagLabel) {
          const [_, versionTag] = versionTagLabel;
          versionTagFromLabel = versionTag;
        }
        
        if (uniqueIdLabel) {
          const [_, uniqueId] = uniqueIdLabel;
          // Check if any service in the compose file has this unique ID in its labels
          persisted = Object.values(composeFile.services || {}).some(service => {
            if (Array.isArray(service.labels)) {
              return service.labels.some((label: string) => label === `com.molo17.conductor.unique_id=${uniqueId}`);
            }
            return false;
          });
        }
      } catch (ymlError) {
        req.log.warn(`Could not read compose file: ${ymlError instanceof Error ? ymlError.message : String(ymlError)}`);
        // Continue without the compose file
      }
      
      // Construct the response in the same format as add/update
      const containerData: ContainerData = {
        imageName,
        type,
        nickname: details.Name ? details.Name.replace(/^\//, '') : '',
        tag: tag || 'latest',
        versionTag: versionTagFromLabel || tag || 'latest', // Use label if available, otherwise use parsed tag
        environment,
        ports,
        volumes,
        persisted,
        hostConfig: details.HostConfig || {} // Include full HostConfig from inspect
      };
      
      return reply.send({
        success: true,
        data: containerData,
        systemInfo: {
          ncpu: systemInfo.ncpu,
          memTotal: systemInfo.memTotal
        }
      } as any); // Type assertion to bypass type checking temporarily
      
    } catch (containerError) {
      req.log.error(`Error inspecting container ${id}: ${containerError instanceof Error ? containerError.message : String(containerError)}`);
      
      if ((containerError as any).statusCode === 404) {
        return reply.code(404).send({
          success: false,
          error: `Container with ID ${id} not found`
        });
      }
      
      return reply.code(500).send({
        success: false,
        error: `Error inspecting container: ${containerError instanceof Error ? containerError.message : String(containerError)}`
      });
    }
  } catch (error) {
    req.log.error(`Error getting container: ${error instanceof Error ? error.message : JSON.stringify(error)}`);
    return reply.code(500).send({
      success: false,
      error: `Failed to get container: ${error instanceof Error ? error.message : String(error)}`
    });
  }
};

export default handler;

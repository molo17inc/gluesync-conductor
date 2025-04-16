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

import { UpdateContainerHandler } from './updateContainer.model';
import { ComposeFile } from '../../../models/composeFile.model';

import writeYmlFile from '../../../helpers/writeYmlFile/writeYmlFile';
import readYmlFile from '../../../helpers/readYmlFile/readYmlFile';

const filename = 'compose.agents.yml';

const handler: UpdateContainerHandler = async (req, reply) => {
  try {
    const { id } = req.params;
    const { imageName, type, name, tag, environment, ports, volumes } =
      req.body;

    // Read the current compose file
    const composeFile = (await readYmlFile<ComposeFile>(filename)) || {};

    // Find the service with the matching container ID
    let serviceKey: string | null = null;

    // First, get the container details to match with the compose file
    try {
      const container = req.server.docker.getContainer(id);
      const details = await container.inspect();

      // Get the container name without the leading slash
      const containerName = details.Name ? details.Name.replace(/^\//, '') : '';

      // Find the service with the matching container name
      for (const [key, service] of Object.entries(composeFile.services || {})) {
        if (service.container_name === containerName) {
          serviceKey = key;
          break;
        }
      }

      if (!serviceKey) {
        return reply.code(404).send({
          success: false,
          error: `Container with ID ${id} not found in the compose file`,
        });
      }

      // Update the service with the new values
      const currentService = composeFile.services?.[serviceKey] || {};

      // Parse the current image to get the base name if imageName is not provided
      const currentImage = currentService.image || '';
      const currentImageParts = currentImage.split(':');
      const currentImageName = currentImageParts[0];

      // Get the container name (either the new one or the existing one)
      const containerName2 = name || currentService.container_name;

      // Get the container tag (either the new one or the existing one)
      const currentTag = currentImage.split(':')[1] || 'latest';
      const containerTag = tag || currentTag;

      // Update the service
      composeFile.services = {
        ...composeFile.services,
        [serviceKey]: {
          ...currentService,
          // Only update the image if imageName or tag is provided
          ...(imageName || tag
            ? {
                image: `molo17/${imageName || currentImageName.replace('molo17/', '')}:${containerTag}`,
              }
            : {}),
          // Only update the container_name if name is provided
          ...(name ? { container_name: name } : {}),
          // Always update the labels to ensure we have the unique_id and versiontag
          labels: [
            `com.molo17.conductor.unique_id=${containerName2}`,
            `com.molo17.conductor.versiontag=${containerTag}`,
          ],
          // Only update the environment if environment is provided
          ...(environment
            ? {
                environment: Object.entries({
                  ...(currentService.environment || []).reduce(
                    (acc: Record<string, string>, env: string) => {
                      const [key, value] = env.split('=');
                      return { ...acc, [key]: value };
                    },
                    {},
                  ),
                  ...(type ? { type } : {}),
                  ...environment,
                }).map(([key, value]) => `${key}=${value}`),
              }
            : {}),
          // Only update the ports if ports is provided
          ...(ports ? { ports } : {}),
          // Only update the volumes if volumes is provided
          ...(volumes
            ? {
                volumes: [
                  // Keep the default volumes
                  './gs-license.dat:/opt/gluesync/data/gs-license.dat:ro',
                  './logback.xml:/opt/gluesync/data/logback.xml:ro',
                  './security-config.json:/opt/gluesync/data/security-config.json:ro',
                  './gluesync.com.jks:/opt/gluesync/data/gluesync.com.jks:ro',
                  './bootstrap-core-hub.json:/opt/gluesync/data/bootstrap-core-hub.json:ro',
                  `./${serviceKey}:/opt/gluesync/data`,
                  ...volumes,
                ],
              }
            : {}),
        },
      };

      // Write the updated compose file
      await writeYmlFile(composeFile, filename);

      reply.statusCode = 200;
      reply.send({
        success: true,
        data: composeFile,
      });
    } catch (containerError) {
      req.log.error(
        `Error inspecting container ${id}: ${containerError instanceof Error ? containerError.message : String(containerError)}`,
      );
      return reply.code(500).send({
        success: false,
        error: `Error inspecting container: ${containerError instanceof Error ? containerError.message : String(containerError)}`,
      });
    }
  } catch (error) {
    req.log.error(
      `Error updating container: ${error instanceof Error ? error.message : JSON.stringify(error)}`,
    );
    return reply.code(500).send({
      success: false,
      error: `Error updating container: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
};

export default handler;

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

import { RouteHandlerMethod } from 'fastify';
import axios from 'axios';
import parseImage from '../../../helpers/parseImage/parseImage';
import Docker from 'dockerode';

const handler: RouteHandlerMethod = async (req, reply) => {
  try {
    const { id } = req.params as { id: string };

    // Get Docker client from the request
    const docker = (req as any).server.docker as Docker;
    if (!docker) {
      throw new Error('Docker client not available');
    }

    // Get the container by ID
    const container = docker.getContainer(id);

    // Inspect the container to get details
    const details = await container.inspect();

    // Extract the image name from the container
    const imageString = details.Config?.Image || '';
    const { imageName, tag } = parseImage(imageString);

    if (!imageName) {
      return reply.code(404).send({
        success: false,
        error: 'Image name not found for this container',
      });
    }

    try {
      // Make a request to the backoffice API to get the latest version
      const response = await axios.get(
        `https://api.backoffice.molo17.com/agent/${imageName}`,
      );

      // Return the response data
      return reply.send({
        success: true,
        data: {
          containerId: id,
          containerName: details.Name ? details.Name.replace(/^\//, '') : '',
          currentImage: imageString,
          currentTag: tag,
          latestVersion: response.data,
        },
      });
    } catch (apiError) {
      req.log.error(
        `Error fetching latest version for ${imageName}: ${apiError instanceof Error ? apiError.message : String(apiError)}`,
      );
      return reply.code(502).send({
        success: false,
        error: `Failed to fetch latest version from API: ${apiError instanceof Error ? apiError.message : String(apiError)}`,
      });
    }
  } catch (error: unknown) {
    req.log.error(
      `Error getting container version: ${error instanceof Error ? error.message : String(error)}`,
    );

    if (error instanceof Error && (error as any).statusCode === 404) {
      return reply
        .code(404)
        .send({ success: false, error: 'Container not found' });
    }

    return reply.code(500).send({
      success: false,
      error: `Failed to get container version: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
};

export default handler;

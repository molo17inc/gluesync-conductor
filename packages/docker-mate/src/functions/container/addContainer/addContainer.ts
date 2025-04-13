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

import { AddContainerHandler } from './addContainer.model';
import { ComposeFile } from '../../../models/composeFile.model';

import writeYmlFile from '../../../helpers/writeYmlFile/writeYmlFile';
import readYmlFile from '../../../helpers/readYmlFile/readYmlFile';
import mergeComposeFiles from '../../../helpers/mergeComposeFiles/mergeComposeFiles';

const filename = 'compose.agents.yml';

const handler: AddContainerHandler = async (req, reply) => {
  try {
    const parsedJson = await readYmlFile<ComposeFile>(filename);

    const composeFile = (req.body.containers || []).reduce<ComposeFile>(
      (
        acc,
        {
          imageName,
          type,
          nickname,
          tag,
          environment,
          ports = [],
          volumes = [],
        },
      ) => {
        if (!type) {
          return acc;
        }

        const containerName = `${imageName}-${type}-agent`;
        const containerNickname = nickname || containerName;

        return {
          ...acc,
          services: {
            ...acc.services,
            [containerName]: {
              ...acc?.services?.[containerName],
              image: `molo17/${imageName}:${tag || 'latest'}`,
              container_name: containerNickname,
              restart: 'unless-stopped',
              labels: [
                `com.molo17.conductor.unique_id=${containerNickname}`
              ],
              environment: Object.entries({
                type,
                maxRamPercentage: 90.0,
                LOG_CONFIG_FILE: '/opt/gluesync/data/logback.xml',
                GLUESYNC_MODULE_TAG: 'gluesync-conductor', // Default module tag
                ...environment,
              }).map(([key, value]) => `${key}=${value}`),
              ports,
              volumes: [
                './gs-license.dat:/opt/gluesync/data/gs-license.dat:ro',
                './logback.xml:/opt/gluesync/data/logback.xml:ro',
                './security-config.json:/opt/gluesync/data/security-config.json:ro',
                './gluesync.com.jks:/opt/gluesync/data/gluesync.com.jks:ro',
                './bootstrap-core-hub.json:/opt/gluesync/data/bootstrap-core-hub.json:ro',
                `./${containerName}:/opt/gluesync/data`,
                ...volumes,
              ],
            },
          },
        };
      },
      {},
    );

    const newComposeFile = mergeComposeFiles([parsedJson, composeFile]);

    await writeYmlFile(newComposeFile, filename);

    reply.statusCode = 200;
    reply.send({ success: true, data: newComposeFile });
  } catch (error) {
    req.log.error(`Error adding container: ${error instanceof Error ? error.message : JSON.stringify(error)}`);
    reply.statusCode = 500;
    reply.send({ 
      success: false, 
      error: `Failed to add container: ${error instanceof Error ? error.message : String(error)}` 
    });
  }
};

export default handler;

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
import { RawComposeFile } from '../../../models/composeFile.model';

import writeComposeFile from '../../../helpers/composeFile/writeComposeFile/writeComposeFile';
import readComposeFile from '../../../helpers/composeFile/readComposeFile/readComposeFile';
import mergeComposeFiles, {
  mergeServices,
} from '../../../helpers/composeFile/mergeComposeFiles/mergeComposeFiles';
import createComposeService from '../../../helpers/composeFile/createComposeService/createComposeService';

const handler: AddContainerHandler = async (req, reply) => {
  try {
    const composeJson = (await readComposeFile()) || {};

    const composeFile = (req.body.containers || []).reduce<RawComposeFile>(
      (acc, container) => {
        if (!container.type) {
          return acc;
        }

        const {
          imageName,
          type,
          nickname,
          tag,
          environment,
          labels,
          ports = [],
          volumes = [],
        } = container;

        const service = createComposeService('container', {
          imageName,
          type,
          nickname,
          tag,
          environment,
          ports,
          volumes,
          labels,
        });

        return {
          ...acc,
          services: mergeServices([
            acc.services || {},
            { [service.container_name]: service },
          ]),
        };
      },
      {},
    );

    const newComposeFile = mergeComposeFiles([composeJson, composeFile]);

    await writeComposeFile(newComposeFile);

    reply.statusCode = 200;
    reply.send({ success: true, data: newComposeFile });
  } catch (error) {
    req.log.error(
      `Error adding container: ${error instanceof Error ? error.message : JSON.stringify(error)}`,
    );
    reply.statusCode = 500;
    reply.send({
      success: false,
      error: `Failed to add container: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
};

export default handler;

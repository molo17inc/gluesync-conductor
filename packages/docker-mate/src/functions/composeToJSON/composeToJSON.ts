import {
  ComposeToJSONHandler,
  ComposeToJSONParams,
} from './composeToJSON.model';

import readComposeFile from '../../helpers/composeFile/readComposeFile/readComposeFile';
import writeComposeFile from '../../helpers/composeFile/writeComposeFile/writeComposeFile';
import { castObject } from '../../helpers/composeFile/extractKeyValue/extractKeyValue';

const handler: ComposeToJSONHandler = async (req, reply) => {
  try {
    const { raw } = castObject<ComposeToJSONParams>(req.query);

    const composeJson = (await readComposeFile(undefined, { raw })) || {};

    req.log.debug(`Current query: ${raw}, ${typeof raw}`);

    await writeComposeFile(composeJson, 'compose.generated.yml');

    reply.statusCode = 200;
    reply.send({ success: true, data: composeJson });
  } catch (error) {
    req.log.error(
      `Error getting compose file: ${error instanceof Error ? error.message : JSON.stringify(error)}`,
    );
    reply.statusCode = 500;
    reply.send({
      success: false,
      error: `Failed to get compose file: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
};

export default handler;

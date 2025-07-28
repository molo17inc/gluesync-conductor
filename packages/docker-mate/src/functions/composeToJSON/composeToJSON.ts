import { ComposeToJSONHandler } from './composeToJSON.model';

import readComposeFile from '../../helpers/composeFile/readComposeFile/readComposeFile';
import writeComposeFile from '../../helpers/composeFile/writeComposeFile/writeComposeFile';

const handler: ComposeToJSONHandler = async (req, reply) => {
  try {
    const { raw } = req.query;

    const composeJson = (await readComposeFile()) || {};

    req.log.debug(`Current query: ${raw}`);

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

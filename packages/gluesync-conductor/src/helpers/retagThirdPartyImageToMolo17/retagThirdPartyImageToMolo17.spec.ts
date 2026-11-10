import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import loadWithStubs from '../../testing/loadWithStubs';
import { ImageNotPublishedError } from '../agentInfo/agentInfo.errors';
import type { retagThirdPartyImageToMolo17GA as Retag } from './retagThirdPartyImageToMolo17';

type Backoffice = Readonly<Record<string, string | Error>>;

const load = (backoffice: Backoffice) => {
  const asked: string[] = [];
  const retag = loadWithStubs<{ default: typeof Retag }>(
    path.resolve(__dirname, './retagThirdPartyImageToMolo17'),
    {
      [path.resolve(__dirname, '../agentInfo/agentInfo')]: {
        default: async (imageName: string) => {
          asked.push(imageName);
          const entry =
            backoffice[imageName] ?? new Error(`unknown ${imageName}`);
          if (entry instanceof Error) {
            throw entry;
          }
          return { latestVersionGA: entry };
        },
      },
    },
  ).default;
  return { retag, asked };
};

describe('retagThirdPartyImageToMolo17GA', () => {
  it('moves a third-party image to the MOLO17 GA build', async () => {
    const { retag, asked } = load({ traefik: '3.7.5' });

    assert.equal(await retag('traefik:v3.1', false), 'molo17/traefik:3.7.5');
    assert.deepEqual(asked, ['traefik']);
  });

  it('asks for the Windows build and suffixes its tag', async () => {
    const { retag } = load({ 'traefik-win-2019': '3.7.5' });

    assert.equal(
      await retag('traefik:v3.1', true, '2019'),
      'molo17/traefik:3.7.5-win-nanoserver-ltsc2019',
    );
  });

  it('leaves the image alone when the backoffice does not publish that build', async () => {
    const { retag } = load({
      'traefik-win-2019': new ImageNotPublishedError('traefik-win-2019'),
    });

    assert.equal(await retag('traefik:v3.1', true, '2019'), null);
  });

  it('lets any other backoffice failure through', async () => {
    const { retag } = load({ traefik: new Error('ECONNRESET') });

    await assert.rejects(retag('traefik:v3.1', false), /ECONNRESET/);
  });

  it('touches neither a MOLO17 image nor an unknown third party', async () => {
    const { retag, asked } = load({});

    assert.equal(await retag('molo17/traefik:3.7.5', false), null);
    assert.equal(await retag('nginx:1.25', false), null);
    assert.deepEqual(asked, []);
  });
});

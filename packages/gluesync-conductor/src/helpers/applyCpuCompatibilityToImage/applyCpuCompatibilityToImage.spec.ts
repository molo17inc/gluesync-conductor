import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import loadWithStubs from '../../testing/loadWithStubs';
import { RawComposeService } from '../../models/composeFile.model';

type Subject = typeof import('./applyCpuCompatibilityToImage');

type Services = Readonly<Record<string, RawComposeService>>;

const CORE_HUB = 'molo17/gluesync-core-hub';
const CHRONOS = 'molo17/gluesync-chronos';

const load = ({
  cpuSupportsV3,
  existing = [],
}: Readonly<{
  cpuSupportsV3: boolean;
  existing?: ReadonlyArray<string>;
}>) => {
  const asked: string[] = [];
  const detections: number[] = [];

  const subject = loadWithStubs<Subject>(
    path.resolve(__dirname, './applyCpuCompatibilityToImage'),
    {
      [path.resolve(
        __dirname,
        '../detectCpuSupportsX86_64V3/detectCpuSupportsX86_64V3',
      )]: {
        default: () => {
          detections.push(1);
          return cpuSupportsV3;
        },
      },
      [path.resolve(__dirname, '../dockerImageExists/dockerImageExists')]: {
        default: async () => false,
      },
    },
  );

  const imageExists = async (image: string) => {
    asked.push(image);
    return existing.includes(image);
  };

  return { ...subject, imageExists, asked, detections };
};

const servicesOf = (...images: ReadonlyArray<string>): Services =>
  Object.fromEntries(
    images.map((image, i) => [`svc${i}`, { image } as RawComposeService]),
  );

const imagesOf = (services: Services): ReadonlyArray<string> =>
  Object.values(services).map(s => s.image);

describe('applyCpuCompatibilityToImage', () => {
  describe('on an old CPU (no x86-64-v3)', () => {
    it('adds -debian to Core Hub without asking anyone', async () => {
      const {
        default: apply,
        imageExists,
        asked,
      } = load({
        cpuSupportsV3: false,
      });
      const services = servicesOf(`${CORE_HUB}:2.3.1`);

      const result = await apply(services, ['svc0'], false, imageExists);

      assert.deepEqual(imagesOf(result.services), [`${CORE_HUB}:2.3.1-debian`]);
      assert.deepEqual(result.updatedIds, ['svc0']);
      assert.deepEqual(asked, []);
    });

    it('adds -debian to Chronos when that image exists', async () => {
      const {
        default: apply,
        imageExists,
        asked,
      } = load({
        cpuSupportsV3: false,
        existing: [`${CHRONOS}:0.3.2-debian`],
      });

      const result = await apply(
        servicesOf(`${CHRONOS}:0.3.2`),
        ['svc0'],
        false,
        imageExists,
      );

      assert.deepEqual(imagesOf(result.services), [`${CHRONOS}:0.3.2-debian`]);
      assert.deepEqual(result.updatedIds, ['svc0']);
      assert.deepEqual(asked, [`${CHRONOS}:0.3.2-debian`]);
    });

    it('keeps Chronos 0.3.1, which has no -debian image, and reports no update', async () => {
      const { default: apply, imageExists } = load({ cpuSupportsV3: false });
      const services = servicesOf(`${CHRONOS}:0.3.1`);

      const result = await apply(services, ['svc0'], false, imageExists);

      assert.equal(result.services, services);
      assert.deepEqual(result.updatedIds, []);
    });

    it('leaves a Chronos that already is -debian alone, without asking', async () => {
      const {
        default: apply,
        imageExists,
        asked,
      } = load({
        cpuSupportsV3: false,
      });
      const services = servicesOf(`${CHRONOS}:0.3.2-debian`);

      const result = await apply(services, ['svc0'], false, imageExists);

      assert.equal(result.services, services);
      assert.deepEqual(result.updatedIds, []);
      assert.deepEqual(asked, []);
    });

    it('treats an untagged Chronos as latest', async () => {
      const {
        default: apply,
        imageExists,
        asked,
      } = load({
        cpuSupportsV3: false,
        existing: [`${CHRONOS}:latest-debian`],
      });

      const result = await apply(
        servicesOf(CHRONOS),
        ['svc0'],
        false,
        imageExists,
      );

      assert.deepEqual(asked, [`${CHRONOS}:latest-debian`]);
      assert.deepEqual(imagesOf(result.services), [`${CHRONOS}:latest-debian`]);
    });

    it('leaves a digest-pinned or interpolated Chronos tag to the customer', async () => {
      const {
        default: apply,
        imageExists,
        asked,
      } = load({
        cpuSupportsV3: false,
        existing: ['anything'],
      });
      // eslint-disable-next-line no-template-curly-in-string -- Compose interpolation is the subject
      const interpolated = `${CHRONOS}:\${TAG:-0.3.2}`;
      const services = servicesOf(`${CHRONOS}:0.3.2@sha256:abc`, interpolated);

      const result = await apply(
        services,
        ['svc0', 'svc1'],
        false,
        imageExists,
      );

      assert.equal(result.services, services);
      assert.deepEqual(asked, []);
    });

    it('does not touch other services', async () => {
      const {
        default: apply,
        imageExists,
        asked,
      } = load({
        cpuSupportsV3: false,
      });
      const services = servicesOf(
        'molo17/grafana:11',
        'molo17/gluesync-mssql-cdc:2.3.1',
      );

      const result = await apply(
        services,
        ['svc0', 'svc1'],
        false,
        imageExists,
      );

      assert.equal(result.services, services);
      assert.deepEqual(asked, []);
    });
  });

  describe('on a CPU with x86-64-v3', () => {
    it('strips -debian from Core Hub and from Chronos', async () => {
      const {
        default: apply,
        imageExists,
        asked,
      } = load({
        cpuSupportsV3: true,
      });

      const result = await apply(
        servicesOf(`${CORE_HUB}:2.3.1-debian`, `${CHRONOS}:0.3.2-debian`),
        ['svc0', 'svc1'],
        false,
        imageExists,
      );

      assert.deepEqual(imagesOf(result.services), [
        `${CORE_HUB}:2.3.1`,
        `${CHRONOS}:0.3.2`,
      ]);
      assert.deepEqual(result.updatedIds, ['svc0', 'svc1']);
      assert.deepEqual(asked, []);
    });

    it('leaves plain images alone', async () => {
      const { default: apply, imageExists } = load({ cpuSupportsV3: true });
      const services = servicesOf(`${CORE_HUB}:2.3.1`, `${CHRONOS}:0.3.2`);

      const result = await apply(
        services,
        ['svc0', 'svc1'],
        false,
        imageExists,
      );

      assert.equal(result.services, services);
      assert.deepEqual(result.updatedIds, []);
    });
  });

  it('touches nothing on Windows, not even the CPU detection', async () => {
    const {
      default: apply,
      imageExists,
      asked,
      detections,
    } = load({
      cpuSupportsV3: false,
      existing: [`${CHRONOS}:0.3.2-debian`],
    });
    const services = servicesOf(`${CORE_HUB}:2.3.1`, `${CHRONOS}:0.3.2`);

    const result = await apply(services, ['svc0', 'svc1'], true, imageExists);

    assert.equal(result.services, services);
    assert.deepEqual(result.updatedIds, []);
    assert.deepEqual(asked, []);
    assert.deepEqual(detections, []);
  });
});

describe('cpuCompatibleChronosUpdateImage', () => {
  it('moves a plain Chronos to <new>-debian on an old CPU when it exists', async () => {
    const { cpuCompatibleChronosUpdateImage, imageExists } = load({
      cpuSupportsV3: false,
      existing: [`${CHRONOS}:0.3.2-debian`],
    });

    assert.equal(
      await cpuCompatibleChronosUpdateImage(
        `${CHRONOS}:0.3.2`,
        false,
        imageExists,
      ),
      `${CHRONOS}:0.3.2-debian`,
    );
  });

  it('keeps it plain when the new version has no -debian image', async () => {
    const { cpuCompatibleChronosUpdateImage, imageExists } = load({
      cpuSupportsV3: false,
    });

    assert.equal(
      await cpuCompatibleChronosUpdateImage(
        `${CHRONOS}:0.3.2`,
        false,
        imageExists,
      ),
      `${CHRONOS}:0.3.2`,
    );
  });

  it('never strips an existing -debian, nor asks, nor detects the CPU', async () => {
    const { cpuCompatibleChronosUpdateImage, imageExists, asked, detections } =
      load({ cpuSupportsV3: true });

    assert.equal(
      await cpuCompatibleChronosUpdateImage(
        `${CHRONOS}:0.3.3-debian`,
        false,
        imageExists,
      ),
      `${CHRONOS}:0.3.3-debian`,
    );
    assert.deepEqual(asked, []);
    assert.deepEqual(detections, []);
  });

  it('leaves a plain Chronos on a v3 CPU, Windows, and other services alone', async () => {
    const v3 = load({ cpuSupportsV3: true });
    const old = load({
      cpuSupportsV3: false,
      existing: [`${CHRONOS}:0.3.2-debian`, `${CORE_HUB}:2.3.1-debian`],
    });

    assert.equal(
      await v3.cpuCompatibleChronosUpdateImage(
        `${CHRONOS}:0.3.2`,
        false,
        v3.imageExists,
      ),
      `${CHRONOS}:0.3.2`,
    );
    assert.equal(
      await old.cpuCompatibleChronosUpdateImage(
        `${CHRONOS}:0.3.2`,
        true,
        old.imageExists,
      ),
      `${CHRONOS}:0.3.2`,
    );
    assert.equal(
      await old.cpuCompatibleChronosUpdateImage(
        `${CORE_HUB}:2.3.1`,
        false,
        old.imageExists,
      ),
      `${CORE_HUB}:2.3.1`,
    );
  });
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  SERVICE_ACCOUNT_DIR,
  detectKubernetesNamespace,
  hasEngineSocket,
  isInPod,
  readNamespace,
} from './kubernetesEnvironment';

const TOKEN = `${SERVICE_ACCOUNT_DIR}/token`;
const NAMESPACE = `${SERVICE_ACCOUNT_DIR}/namespace`;

type World = Readonly<{
  env?: Record<string, string>;
  files?: Readonly<Record<string, string>>;
  platform?: NodeJS.Platform;
}>;

const world = ({ env = {}, files = {}, platform = 'linux' }: World = {}) => ({
  env,
  platform,
  fileExists: (path: string) => path in files,
  readFile: (path: string) => {
    if (!(path in files)) {
      throw Object.assign(new Error(`ENOENT ${path}`), { code: 'ENOENT' });
    }
    return files[path];
  },
});

const POD = {
  env: { KUBERNETES_SERVICE_HOST: '10.96.0.1' },
  files: { [TOKEN]: 'token', [NAMESPACE]: 'kit\n' },
};

describe('kubernetesEnvironment', () => {
  describe('detectKubernetesNamespace', () => {
    it('detects a pod that has no container engine socket', () => {
      assert.equal(detectKubernetesNamespace(world(POD)), 'kit');
    });

    it('is not Kubernetes outside a pod', () => {
      assert.equal(detectKubernetesNamespace(world()), undefined);
    });

    it('is not Kubernetes when the service account token is not mounted', () => {
      assert.equal(
        detectKubernetesNamespace(world({ env: POD.env, files: {} })),
        undefined,
      );
    });

    it('is not Kubernetes when the token is there but not the API address', () => {
      assert.equal(
        detectKubernetesNamespace(world({ files: POD.files })),
        undefined,
      );
    });

    it('leaves a pod that mounts an engine socket in compose or swarm', () => {
      ['/var/run/docker.sock', '/run/podman/podman.sock'].forEach(socket => {
        assert.equal(
          detectKubernetesNamespace(
            world({ ...POD, files: { ...POD.files, [socket]: '' } }),
          ),
          undefined,
          socket,
        );
      });
    });

    it('leaves a pod that is given a network engine address in compose or swarm', () => {
      ['DOCKER_HOST', 'CONTAINER_HOST'].forEach(key => {
        assert.equal(
          detectKubernetesNamespace(
            world({ ...POD, env: { ...POD.env, [key]: 'tcp://dind:2375' } }),
          ),
          undefined,
          key,
        );
      });
    });

    it('detects a pod whose DOCKER_HOST names a socket that is not mounted, as the image sets it', () => {
      const env = { ...POD.env, DOCKER_HOST: 'unix:///var/run/docker.sock' };

      assert.equal(detectKubernetesNamespace(world({ ...POD, env })), 'kit');
      assert.equal(
        detectKubernetesNamespace(
          world({
            env,
            files: { ...POD.files, '/var/run/docker.sock': '' },
          }),
        ),
        undefined,
      );
    });

    it('looks only where the engine client would connect', () => {
      // DOCKER_HOST wins over the well-known sockets, as in getDocker
      assert.equal(
        detectKubernetesNamespace(
          world({
            env: { ...POD.env, DOCKER_HOST: '/custom/docker.sock' },
            files: { ...POD.files, '/run/podman/podman.sock': '' },
          }),
        ),
        'kit',
      );
      assert.equal(
        detectKubernetesNamespace(
          world({
            env: {
              ...POD.env,
              CONTAINER_HOST: 'unix:///run/podman/podman.sock',
            },
            files: { ...POD.files, '/run/podman/podman.sock': '' },
          }),
        ),
        undefined,
      );
    });

    it('is forced by CONDUCTOR_ORCHESTRATOR=kubernetes, socket or not', () => {
      assert.equal(
        detectKubernetesNamespace(
          world({
            env: { CONDUCTOR_ORCHESTRATOR: ' Kubernetes ', POD_NAMESPACE: 'x' },
            files: { '/var/run/docker.sock': '' },
          }),
        ),
        'x',
      );
    });

    it('is ruled out by CONDUCTOR_ORCHESTRATOR=compose or swarm, even in a pod', () => {
      ['compose', 'swarm'].forEach(forced => {
        assert.equal(
          detectKubernetesNamespace(
            world({
              ...POD,
              env: { ...POD.env, CONDUCTOR_ORCHESTRATOR: forced },
            }),
          ),
          undefined,
          forced,
        );
      });
    });

    it('ignores an unknown CONDUCTOR_ORCHESTRATOR and detects', () => {
      assert.equal(
        detectKubernetesNamespace(
          world({ ...POD, env: { ...POD.env, CONDUCTOR_ORCHESTRATOR: 'k3s' } }),
        ),
        'kit',
      );
    });
  });

  describe('readNamespace', () => {
    it('prefers POD_NAMESPACE over the service account file', () => {
      assert.equal(
        readNamespace(
          world({ env: { POD_NAMESPACE: ' from-env ' }, files: POD.files }),
        ),
        'from-env',
      );
    });

    it('reads the service account namespace file', () => {
      assert.equal(readNamespace(world({ files: POD.files })), 'kit');
    });

    it('answers default when neither is there', () => {
      assert.equal(readNamespace(world()), 'default');
      assert.equal(
        readNamespace(world({ files: { [NAMESPACE]: ' ' } })),
        'default',
      );
    });
  });

  describe('isInPod / hasEngineSocket', () => {
    it('needs both the API address and the token', () => {
      assert.equal(isInPod(world(POD)), true);
      assert.equal(isInPod(world({ env: POD.env })), false);
    });

    it('looks at the rootless Podman socket too', () => {
      assert.equal(
        hasEngineSocket(
          world({
            env: { XDG_RUNTIME_DIR: '/run/user/1000' },
            files: { '/run/user/1000/podman/podman.sock': '' },
          }),
        ),
        true,
      );
      assert.equal(hasEngineSocket(world()), false);
    });

    it('looks at the engine pipe on Windows', () => {
      assert.equal(
        hasEngineSocket(
          world({
            platform: 'win32',
            files: { [String.raw`\\.\pipe\docker_engine`]: '' },
          }),
        ),
        true,
      );
      assert.equal(
        hasEngineSocket(
          world({ platform: 'win32', files: { '/var/run/docker.sock': '' } }),
        ),
        false,
      );
      assert.equal(
        hasEngineSocket(
          world({
            platform: 'win32',
            env: { DOCKER_HOST: 'npipe:////./pipe/docker_engine' },
            files: { [String.raw`\\.\pipe\docker_engine`]: '' },
          }),
        ),
        true,
      );
      assert.equal(
        hasEngineSocket(
          world({
            platform: 'win32',
            env: { DOCKER_HOST: 'npipe:////./pipe/docker_engine' },
          }),
        ),
        false,
      );
    });
  });
});

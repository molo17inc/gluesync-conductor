// The few fields of the Kubernetes API objects the Conductor reads

export type KubernetesLabels = Readonly<Record<string, string>>;

export type KubernetesMeta = Readonly<{
  name: string;
  namespace?: string;
  uid?: string;
  labels?: KubernetesLabels;
  creationTimestamp?: string;
  deletionTimestamp?: string;
}>;

export type KubernetesEnvVar = Readonly<{
  name: string;
  // Absent when the value comes from a Secret, a ConfigMap or a field
  value?: string;
  valueFrom?: unknown;
}>;

export type KubernetesContainer = Readonly<{
  name: string;
  image?: string;
  env?: ReadonlyArray<KubernetesEnvVar>;
  ports?: ReadonlyArray<
    Readonly<{ containerPort: number; protocol?: string; name?: string }>
  >;
  volumeMounts?: ReadonlyArray<
    Readonly<{ name: string; mountPath: string; readOnly?: boolean }>
  >;
}>;

export type KubernetesVolume = Readonly<{
  name: string;
  persistentVolumeClaim?: Readonly<{ claimName: string }>;
  secret?: Readonly<{ secretName?: string }>;
  configMap?: Readonly<{ name?: string }>;
  hostPath?: Readonly<{ path: string }>;
  emptyDir?: unknown;
  [source: string]: unknown;
}>;

export type KubernetesPodSpec = Readonly<{
  nodeName?: string;
  containers?: ReadonlyArray<KubernetesContainer>;
  volumes?: ReadonlyArray<KubernetesVolume>;
}>;

export type KubernetesContainerState = Readonly<{
  running?: Readonly<{ startedAt?: string }>;
  waiting?: Readonly<{ reason?: string; message?: string }>;
  terminated?: Readonly<{ reason?: string; exitCode?: number }>;
}>;

export type KubernetesContainerStatus = Readonly<{
  name: string;
  ready?: boolean;
  restartCount?: number;
  image?: string;
  imageID?: string;
  containerID?: string;
  state?: KubernetesContainerState;
}>;

export type KubernetesPod = Readonly<{
  metadata: KubernetesMeta;
  spec?: KubernetesPodSpec;
  status?: Readonly<{
    phase?: string;
    reason?: string;
    podIP?: string;
    containerStatuses?: ReadonlyArray<KubernetesContainerStatus>;
  }>;
}>;

// A StatefulSet or a Deployment
export type KubernetesWorkloadObject = Readonly<{
  metadata: KubernetesMeta;
  spec?: Readonly<{
    replicas?: number;
    selector?: Readonly<{ matchLabels?: KubernetesLabels }>;
    template?: Readonly<{
      metadata?: Readonly<{ labels?: KubernetesLabels }>;
      spec?: KubernetesPodSpec;
    }>;
  }>;
  status?: Readonly<{
    replicas?: number;
    readyReplicas?: number;
    updatedReplicas?: number;
  }>;
}>;

export type KubernetesList<T> = Readonly<{ items?: ReadonlyArray<T> }>;

export type KubernetesNode = Readonly<{
  metadata: KubernetesMeta;
  status?: Readonly<{
    capacity?: Readonly<Record<string, string>>;
    nodeInfo?: Readonly<{
      architecture?: string;
      operatingSystem?: string;
      osImage?: string;
      kernelVersion?: string;
      kubeletVersion?: string;
      containerRuntimeVersion?: string;
    }>;
  }>;
}>;

// GET /version of the API server
export type KubernetesVersion = Readonly<{
  major?: string;
  minor?: string;
  gitVersion?: string;
  gitCommit?: string;
  buildDate?: string;
  goVersion?: string;
  platform?: string;
}>;

export type KubernetesWorkloadKind = 'StatefulSet' | 'Deployment';

/** A workload of the namespace with the pods its selector matches. */
export type KubernetesWorkload = Readonly<{
  kind: KubernetesWorkloadKind;
  // Name of the object in the cluster (`<release>-gluesync-core-hub`)
  name: string;
  // Docker-style Conductor id (`gluesync-core-hub`)
  id: string;
  namespace: string;
  // `app.kubernetes.io/instance`, when the workload carries it
  release?: string;
  labels: KubernetesLabels;
  // First container of the pod template: the service itself
  container?: KubernetesContainer;
  volumes: ReadonlyArray<KubernetesVolume>;
  image: string;
  desiredReplicas: number;
  readyReplicas: number;
  updatedReplicas: number;
  // Running first, then newest first
  pods: ReadonlyArray<KubernetesPod>;
}>;

// eslint-disable-next-line functional/no-mixed-types -- a client: its namespace and its one call
export type KubernetesClient = Readonly<{
  namespace: string;
  /** GET `path` on the API server; rejects with a `KubernetesApiError`. */
  get: <T>(path: string) => Promise<T>;
}>;

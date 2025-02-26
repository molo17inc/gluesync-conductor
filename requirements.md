# ContainerMate

## Goal

Provide a set of APIs to be consumed from the core hub to allow control plane’s users to manually add whichever agent they want into their deployment, whether based out of docker or Kubernetes.

## Features

- Add agent
  - from agent’s internal name classification
    - look for tag
    - type (source / target)
  - give a nickname to agent (see https://molo17.atlassian.net/browse/GSPRJ-279)
  - attach needed volumes (see default kit config)
  - provide progress status (pulling, starting, stopped, error…)
  - launch pull from repo

- Remove agent

- Agent’s version control
  - provide an API for the corehub to poll and see if an agent has an available update

- Core hub version control
  - provide an API for the corehub to poll and see if an agent has an available update

- Interoperability between docker & K8s
  - opaque client API

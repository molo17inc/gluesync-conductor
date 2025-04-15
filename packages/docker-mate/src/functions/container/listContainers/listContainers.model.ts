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
import { ErrorResponse } from '../../../models/common.model';
import { SystemInfo } from '../getContainer/getContainer.model';

export type ContainerListItem = Readonly<{
  id: string;
  name: string;
  image: string;
  tag: string;
  versionTag: string;
  persisted: boolean;
  created: string;
  running: boolean;
  status: string;
  exitCode: number;
  startedAt: string;
  finishedAt: string;
  cmd: string[];
  env: string[];
  labels: Record<string, string>;
  networkMode: string;
  privileged: boolean;
  ports: any[];
  mounts: any[];
  hostConfig: any; // Full HostConfig from Docker inspect
}>;

export type ListContainersSuccessResponse = Readonly<{
  success: true;
  data: ContainerListItem[];
  systemInfo: SystemInfo;
}>;

export type ListContainersResponse =
  | ListContainersSuccessResponse
  | ErrorResponse;

export type ListContainersHandler = RouteHandlerMethod<
  any,
  any,
  any,
  {
    Reply: ListContainersResponse;
  }
>;

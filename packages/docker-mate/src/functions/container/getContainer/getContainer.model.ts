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
import { ErrorResponse, SuccessResponse } from '../../../models/common.model';

export type GetContainerParams = Readonly<{
  id: string;
}>;

export type SystemInfo = Readonly<{
  ncpu: number;
  memTotal: number;
}>;

export type ContainerData = Readonly<{
  imageName: string;
  type: 'target' | 'source';
  nickname?: string;
  tag?: string;
  versionTag?: string;
  environment?: Record<string, any>;
  ports?: ReadonlyArray<string>;
  volumes?: ReadonlyArray<string>;
  persisted?: boolean;
  hostConfig?: any; // Full HostConfig from Docker inspect
}>;

export type GetContainerSuccessResponse = Readonly<{
  success: true;
  data: ContainerData;
  systemInfo: SystemInfo;
}>;

export type GetContainerResponse = GetContainerSuccessResponse | ErrorResponse;

export type GetContainerHandler = RouteHandlerMethod<
  any,
  any,
  any,
  {
    Params: GetContainerParams;
    Reply: GetContainerResponse;
  }
>;

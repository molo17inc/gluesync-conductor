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

export type AddContainerBody = Readonly<{
  containers: ReadonlyArray<{
    imageName: string;
    type: 'target' | 'source';
    nickname?: string;
    tag?: string;
    environment?: Record<string, any>;
    ports?: ReadonlyArray<string>;
    volumes?: ReadonlyArray<string>;
  }>;
}>;

export type AddContainerResponse = SuccessResponse<any> | ErrorResponse;

export type AddContainerHandler = RouteHandlerMethod<
  any,
  any,
  any,
  {
    Body: Partial<AddContainerBody>;
    Reply: AddContainerResponse;
  }
>;

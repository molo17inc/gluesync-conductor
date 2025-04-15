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

/**
 * Parses a Docker image string and extracts the image name and tag.
 *
 * @param imageString The Docker image string (e.g., "postgres:16-alpine", "n8nio/n8n:latest")
 * @returns An object containing the image name and tag (if present)
 */
export function parseImageTag(imageString: string): {
  name: string;
  tag: string;
} {
  if (!imageString) {
    return { name: '', tag: '' };
  }

  // Split the image string by ":"
  const parts = imageString.split(':');

  // If there's only one part or the second part is empty, there's no tag
  if (parts.length === 1 || !parts[1]) {
    return { name: imageString, tag: '' };
  }

  // Handle the case where the first part might contain a port (e.g., localhost:5000/myimage:tag)
  // We need to check if there are multiple ":" and the first one is part of a registry URL
  if (parts.length > 2) {
    // Check if the first ":" is part of a registry URL (e.g., localhost:5000)
    const registryParts = parts[0].split('/');
    if (registryParts.length > 1 && registryParts[0].includes('.')) {
      // This is likely a registry URL with a port
      const registry = parts.slice(0, 2).join(':');
      const remainder = parts.slice(2).join(':');
      const imageParts = remainder.split(':');
      if (imageParts.length === 1) {
        // No tag after the registry:port/image
        return { name: `${registry}/${remainder}`, tag: '' };
      } else {
        // There is a tag after the registry:port/image
        return {
          name: `${registry}/${imageParts[0]}`,
          tag: imageParts.slice(1).join(':'),
        };
      }
    }
  }

  // Standard case: image:tag
  return {
    name: parts[0],
    tag: parts.slice(1).join(':'), // Join remaining parts in case tag contains ":"
  };
}

export default parseImageTag;

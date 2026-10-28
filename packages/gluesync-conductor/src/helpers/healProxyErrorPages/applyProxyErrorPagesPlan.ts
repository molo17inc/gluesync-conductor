import type { RawComposeFile } from '../../models/composeFile.model';
import {
  addTargetLabels,
  convertLabels,
  removeAllLabels,
} from './composeLabelTransforms';
import type { ProxyErrorPagesPlan } from './healProxyErrorPages.model';
import { addStatic, removeStatic } from './traefikStaticTransforms';

export type ProxyFiles = Readonly<{
  composeJson: Partial<RawComposeFile>;
  traefikYamlText: string;
}>;

/**
 * The two files after the plan: the compose JSON (only the labels change) and
 * the text of traefik.yml (only our keys change). Pure; a plan that changes
 * nothing returns the input as it is.
 */
const applyProxyErrorPagesPlan = (
  files: ProxyFiles,
  plan: ProxyErrorPagesPlan,
  proxyServiceName: string,
  isWindows: boolean,
): ProxyFiles => {
  switch (plan.action) {
    case 'add':
      return {
        composeJson: addTargetLabels(
          files.composeJson,
          proxyServiceName,
          isWindows,
        ),
        traefikYamlText: addStatic(files.traefikYamlText),
      };
    case 'convert':
      return {
        composeJson: convertLabels(
          files.composeJson,
          proxyServiceName,
          isWindows,
        ),
        traefikYamlText: addStatic(files.traefikYamlText, {
          dropLegacyEntry: true,
        }),
      };
    case 'remove':
      return {
        composeJson: removeAllLabels(
          files.composeJson,
          proxyServiceName,
          isWindows,
        ),
        traefikYamlText: removeStatic(files.traefikYamlText),
      };
    default:
      return files;
  }
};

export default applyProxyErrorPagesPlan;

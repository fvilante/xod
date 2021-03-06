import { flip, curry } from 'ramda';

// because functions exported from Reason are uncurried
import { jumperizePatchRecursivelyU } from './Buses_Js.bs';

export * from './project';
export {
  createPatch,
  duplicatePatch,
  getPatchPath,
  setPatchPath,
  getPatchDescription,
  setPatchDescription,
  getPatchAttachments,
  setPatchAttachments,
  hasImpl,
  getImpl,
  setImpl,
  removeImpl,
  nodeIdEquals,
  listNodes,
  getNodeById,
  getNodeByIdUnsafe,
  getPinByKey,
  getPinByKeyUnsafe,
  listPins,
  listInputPins,
  listOutputPins,
  isTerminalPatch,
  validatePinLabels,
  listLinks,
  linkIdEquals,
  getLinkById,
  getLinkByIdUnsafe,
  listLinksByNode,
  listLinksByPin,
  validateLink,
  assocLink,
  dissocLink,
  upsertLinks,
  omitLinks,
  assocNode,
  dissocNode,
  upsertNodes,
  canBindToOutputs,
  toposortNodes,
  getTopology,
  listComments,
  getCommentById,
  getCommentByIdUnsafe,
  assocComment,
  dissocComment,
  upsertComments,
  removeDebugNodes,
  getTopologyMap,
  applyNodeIdMap,
  resolveNodeTypesInPatch,
  listLibraryNamesUsedInPatch,
  computeVariadicPins,
  listVariadicValuePins,
  listVariadicAccPins,
  listVariadicSharedPins,
  validatePatchForVariadics,
  getArityStepFromPatch,
  isVariadicPatch,
  isAbstractPatch,
  isGenuinePatch,
  isConstructorPatch,
  isPatchNotImplementedInXod,
  doesPatchHaveGenericPins,
  validateAbstractPatch,
  validateConstructorPatch,
  isDeprecatedPatch,
  getDeprecationReason,
  isUtilityPatch,
  haveAddedNodesOrChangedTypesOrBoundValues,
  patchListEqualsBy,
  sameCategoryMarkers,
  sameDeducedTypes,
  samePatchValidity,
  validateBuses,
} from './patch';
export {
  getFilename as getAttachmentFilename,
  getContent as getAttachmentContent,
  getEncoding as getAttachmentEncoding,
} from './attachment';
export * from './node';
export * from './comment';
export {
  createPin,
  getPinType,
  getPinDirection,
  getPinKey,
  getPinLabel,
  getPinDefaultValue,
  getPinDescription,
  getPinOrder,
  isInputPin,
  isOutputPin,
  isTerminalPin,
  normalizeEmptyPinLabels,
  isPinBindable,
  isPulsePin,
} from './pin';
export * from './link';
export * from './constants';
export * from './optionalFieldsUtils';
export * from './utils';
export * from './types';
export { default as flatten } from './flatten';
export {
  default as extractBoundInputsToConstNodes,
} from './extractBoundInputsToConstNodes';
export { default as expandVariadicNodes } from './expandVariadicNodes';
export * from './patchPathUtils';
export * from './versionUtils';
export * from './xodball';
export * from './typeDeduction';
export * from './TypeDeduction_Js.bs';
export { default as autoresolveTypes } from './autoresolveTypes';
export const jumperizePatchRecursively = curry(
  flip(jumperizePatchRecursivelyU)
);
export { default as messages } from './messages';
export { ensureLiteral, migrateBoundValuesToBoundLiterals } from './legacy';
export { sortGraph } from './gmath';
export { BUILT_IN_TERMINAL_PATCH_PATHS } from './builtinTerminalPatches';

import * as R from 'ramda';
import { Maybe } from 'ramda-fantasy';
import * as XP from 'xod-project';
import {
  foldEither,
  explodeMaybe,
  mergeAllWithConcat,
  mergeAllDeepWithConcat,
  failOnNothing,
} from 'xod-func-tools';

import { getActingPatchPath } from './utils';

// PinValidateFn :: Patch -> Project -> Map PinKey PinErrors
// NodeValidateFn :: Patch -> Project -> Map NodeId NodeErrors
// LinkValidateFn :: Link -> Patch -> Project -> Map PatchPath DeducedPinTypes -> [Error]

// ErrorsUpdateData :: { policy: UPDATE_ERRORS_POLICY, errors: Map PatchPath PatchErrors }

const UPDATE_ERRORS_POLICY = {
  OVERWRITE: 'OVERWRITE_ERRORS', // Overwrites whole object with new one
  MERGE: 'MERGE_ERRORS', // Merges deeply new object into previvous one
  ASSOC: 'ASSOC_ERRORS', // Overwrites only listed patch paths
};

// =============================================================================
//
// Basic validate functions
//
// =============================================================================

export const getMarkerNodesErrorMap = (
  predicate,
  validator,
  errorType
) => patch => {
  const markerNodeIds = R.compose(
    R.map(XP.getNodeId),
    R.filter(predicate),
    XP.listNodes
  )(patch);

  if (R.isEmpty(markerNodeIds)) return {};

  return foldEither(
    err =>
      R.compose(
        mergeAllWithConcat,
        R.map(R.objOf(R.__, { [errorType]: [err] }))
      )(markerNodeIds),
    R.always({ [errorType]: [] }),
    validator(patch)
  );
};

// :: Patch -> Map NodeId (Map ErrorType [Error])
export const getVariadicMarkersErrorMap = getMarkerNodesErrorMap(
  R.pipe(XP.getNodeType, XP.isVariadicPath),
  XP.validatePatchForVariadics,
  'validatePatchForVariadics'
);

// :: Patch -> Map NodeId (Map ErrorType [Error])
export const getAbstractMarkersErrorMap = getMarkerNodesErrorMap(
  R.pipe(XP.getNodeType, R.equals(XP.ABSTRACT_MARKER_PATH)),
  XP.validateAbstractPatch,
  'validateAbstractPatch'
);

// :: Patch -> Map NodeId (Map ErrorType [Error])
export const getConstructorMarkersErrorMap = getMarkerNodesErrorMap(
  R.pipe(XP.getNodeType, R.equals(XP.OUTPUT_SELF_PATH)),
  XP.validateConstructorPatch,
  'validateConstructorPatch'
);

// :: Patch -> Map NodeId (Map ErrorType [Error])
export const getTerminalsErrorMap = R.compose(
  R.map(R.objOf('validatePinLabels')),
  foldEither(
    err =>
      R.compose(
        R.map(R.of),
        R.fromPairs,
        R.map(R.pair(R.__, err)),
        R.path(['payload', 'pinKeys']) // those are affected terminal node ids
      )(err),
    R.always([])
  ),
  XP.validatePinLabels
);

// TODO: Use validator from xod-project after refactoring
// :: Patch -> Project -> Map NodeId (Map ErrorType [Error])
export const getDeadRefErrorMap = (patch, project) =>
  R.compose(
    R.map(
      R.compose(
        R.objOf('checkPatchExists'),
        foldEither(R.of, R.always([])),
        nodeType => {
          const patchPath = XP.getPatchPath(patch);
          return failOnNothing('DEAD_REFERENCE__PATCH_FOR_NODE_NOT_FOUND', {
            nodeType,
            patchPath,
            trace: [patchPath],
          })(XP.getPatchByPath(nodeType, project));
        },
        XP.getNodeType
      )
    ),
    R.indexBy(XP.getNodeId),
    XP.listNodes
  )(patch);

// :: Patch -> Project -> Node -> Map PinKey PinErrors
export const validateBoundValues = R.curry((patch, project, node) =>
  R.compose(
    R.map(
      R.compose(
        R.objOf('errors'),
        R.objOf('getInvalidBoundNodePins'),
        foldEither(R.of, R.always([]))
      )
    ),
    XP.getInvalidBoundNodePins
  )(project, patch, node)
);

// :: Link -> Patch -> Project -> Map PatchPath DeducedPinTypes -> Map ErrorType [Error]
const validateLinkPins = R.curry((link, patch, project, allDeducedPinTypes) =>
  R.compose(
    R.objOf('validateLinkPins'),
    foldEither(R.of, R.always([])),
    XP.validateLinkPins(link, patch, project),
    R.propOr({}, XP.getPatchPath(patch))
  )(allDeducedPinTypes)
);

// =============================================================================
//
// Utility functions to run validations properly
//
// =============================================================================

// :: [NodeValidateFn] -> Patch -> Project -> Map PatchPath PatchErrors -> Map NodeId NodeErrors
const validateNodes = R.curry(
  (nodeValidators, pinValidators, patch, project, prevErrors) =>
    R.compose(
      R.map(R.merge({ errors: {}, pins: {} })),
      // :: Map NodeId NodeErrors
      nodeErrorsMap =>
        R.compose(
          R.mergeDeepWith(R.concat, nodeErrorsMap),
          // :: Map NodeId { pins: Map PinKey (Map ErrorType (Maybe [Error])) }
          R.map(R.objOf('pins')),
          R.map(node =>
            R.compose(
              mergeAllDeepWithConcat,
              R.map(fn => fn(patch, project, node, prevErrors))
            )(pinValidators)
          ),
          R.indexBy(XP.getNodeId),
          XP.listNodes
        )(patch),
      // :: Map NodeId { errors: Map ErrorType [Error] }
      R.map(R.objOf('errors')),
      // :: Map NodeId (Map ErrorType [Error])
      mergeAllDeepWithConcat,
      R.map(fn => fn(patch, project, prevErrors))
    )(nodeValidators)
);

// :: [LinkValidateFn] -> Patch -> Project -> Map PatchPath DeducedPinTypes -> Map PatchPath PatchErrors -> Map LinkId LinkErrors
const validateLinks = R.curry(
  (validators, patch, project, allDeducedPinTypes, prevErrors) =>
    R.compose(
      R.map(R.objOf('errors')),
      R.map(link =>
        R.compose(
          mergeAllDeepWithConcat,
          R.map(fn => fn(link, patch, project, allDeducedPinTypes, prevErrors))
        )(validators)
      ),
      R.indexBy(XP.getLinkId),
      XP.listLinks
    )(patch)
);

// :: [NodeValidateFn] -> [PinValidateFn] -> Patch -> Project -> Map PatchPath PatchErrors -> { nodes: Map NodeId NodeErrors }
const getNodeErrors = R.curry(
  (nodeValidators, pinValidators, patch, project, prevErrors) =>
    R.compose(R.objOf('nodes'), validateNodes(nodeValidators, pinValidators))(
      patch,
      project,
      prevErrors
    )
);
// :: [LinkValidateFn] -> Patch -> Project -> Map PatchPath DeducedPinTypes -> Map PatchPath PatchErrors -> { links: Map LinkId LinkErrors }
const getLinkErrors = R.curry(
  (linkValidators, patch, project, allDeducedPinTypes, prevErrors) =>
    R.compose(R.objOf('links'), validateLinks(linkValidators))(
      patch,
      project,
      allDeducedPinTypes,
      prevErrors
    )
);

// :: PatchPath -> [Patch] -> [Patch]
const filterPatchAndDependentPatchesByPatchPath = R.curry(
  (patchPath, patches) =>
    R.when(
      () => patchPath,
      R.filter(
        R.either(
          XP.hasNodeWithType(patchPath),
          R.pipe(XP.getPatchPath, R.equals(patchPath))
        )
      )
    )(patches)
);

const propChildrenEmpty = R.propSatisfies(R.pipe(R.values, R.all(R.isEmpty)));
const propEmpty = R.propSatisfies(R.isEmpty);

// :: { errors: Map ErrorType [Error] } -> Boolean
const haveNoErrors = R.either(propEmpty('errors'), propChildrenEmpty('errors'));

// :: { pins: Map PinKey (Map ErrorType [Error]) } -> Boolean
const haveNoPinErrors = R.either(
  propEmpty('pins'),
  R.either(
    propChildrenEmpty('pins'),
    R.compose(R.all(propChildrenEmpty('errors')), R.values, R.prop('pins'))
  )
);

// :: { nodes: Map NodeId { errors: Map ErrorType [Error], pins: Map PinKey (Map ErrorType [Error]) } } -> Boolean
const haveNoNodeErrors = R.either(
  propEmpty('nodes'),
  R.compose(
    R.all(R.both(haveNoErrors, haveNoPinErrors)),
    R.values,
    R.prop('nodes')
  )
);

// :: { links: Map LinkId { errors: Map ErrorType [Error] } } -> Boolean
const haveNoLinkErrors = R.either(
  propEmpty('links'),
  R.compose(R.all(haveNoErrors), R.values, R.prop('links'))
);

// :: PatchErrors -> Boolean
const haveNoAnyErrors = R.allPass([
  haveNoErrors,
  haveNoNodeErrors,
  haveNoLinkErrors,
]);

// =============================================================================
//
// API
//
// =============================================================================

export const callFnIfExist = R.curry(
  (fnMap, defFn, action, project, allDeducedPinTypes, prevErrors) =>
    R.compose(
      fn => fn(action, project, allDeducedPinTypes, prevErrors),
      R.defaultTo(defFn),
      R.prop(R.__, fnMap),
      R.prop('type')
    )(action)
);

export const setOverwritePolicy = errors => ({
  policy: UPDATE_ERRORS_POLICY.OVERWRITE,
  errors,
});
export const setMergePolicy = errors => ({
  policy: UPDATE_ERRORS_POLICY.MERGE,
  errors,
});
export const setAssocPolicy = errors => ({
  policy: UPDATE_ERRORS_POLICY.ASSOC,
  errors,
});

// :: [NodeValidateFn] -> [PinValidateFn] -> [LinkValidateFn] -> Project -> Map PatchPath DeducedPinTypes -> Map PatchPath PatchErrors -> [Patch] -> Map PatchPath PatchErrors
export const validatePatches = R.curry(
  (
    nodeValidators,
    pinValidators,
    linkValidators,
    project,
    allDeducedPinTypes,
    prevErrors,
    patches
  ) =>
    R.compose(
      R.map(patch =>
        mergeAllDeepWithConcat([
          { errors: {}, nodes: {}, links: {} },
          getLinkErrors(
            linkValidators,
            patch,
            project,
            allDeducedPinTypes,
            prevErrors
          ),
          getNodeErrors(
            nodeValidators,
            pinValidators,
            patch,
            project,
            prevErrors
          ),
        ])
      ),
      R.indexBy(XP.getPatchPath)
    )(patches)
);

// :: Project -> Map PatchPath DeducedPinTypes -> Map PatchPath PatchErrors -> [Patch] -> Map PatchPath PatchErrors
export const validatePatchesGenerally = validatePatches(
  [
    getDeadRefErrorMap,
    getTerminalsErrorMap,
    getVariadicMarkersErrorMap,
    getAbstractMarkersErrorMap,
    getConstructorMarkersErrorMap,
  ],
  [validateBoundValues],
  [validateLinkPins]
);

// :: Project -> Map PatchPath DeducedPinTypes -> Nullable PatchPath -> Map PatchPath PatchErrors -> Map PatchPath PatchErrors
export const validateLocalPatches = R.curry(
  (project, allDeducedPinTypes, changedPatchPath, prevErrors) =>
    R.compose(
      validatePatchesGenerally(project, allDeducedPinTypes, prevErrors),
      filterPatchAndDependentPatchesByPatchPath(changedPatchPath),
      XP.listLocalPatches
    )(project)
);

// :: Project -> Map PatchPath DeducedPinTypes -> Nullable PatchPath -> Map PatchPath PatchErrors -> Map PatchPath PatchErrors
export const validateAllPatches = R.curry(
  (project, allDeducedPinTypes, changedPatchPath, prevErrors) =>
    R.compose(
      validatePatchesGenerally(project, allDeducedPinTypes, prevErrors),
      filterPatchAndDependentPatchesByPatchPath(changedPatchPath),
      XP.listPatches
    )(project)
);

// :: Action -> Project -> Map PatchPath DeducedPinTypes -> Map PatchPath PatchErrors -> ErrorsUpdateData
export const generalValidator = (
  action,
  project,
  allDeducedPinTypes,
  prevErrors
) => {
  const maybePatchPath = getActingPatchPath(action);
  if (Maybe.isJust(maybePatchPath)) {
    const patchPath = explodeMaybe('IMPOSSIBLE ERROR', maybePatchPath);
    return R.compose(
      R.compose(
        R.ifElse(
          R.has(patchPath),
          () =>
            R.ifElse(
              XP.isPathLocal,
              R.compose(
                setAssocPolicy,
                validateLocalPatches(
                  project,
                  allDeducedPinTypes,
                  R.__,
                  prevErrors
                )
              ),
              R.compose(
                setOverwritePolicy,
                validateAllPatches(
                  project,
                  allDeducedPinTypes,
                  R.__,
                  prevErrors
                )
              )
            )(patchPath),
          setAssocPolicy
        ),
        R.reject(haveNoAnyErrors),
        validatePatchesGenerally(project, allDeducedPinTypes, prevErrors),
        R.of
      ),
      XP.getPatchByPathUnsafe
    )(patchPath, project);
  }

  return R.compose(setOverwritePolicy, validateAllPatches)(
    project,
    allDeducedPinTypes,
    null,
    prevErrors
  );
};

// :: Map PatchPath PatchErrors -> ErrorsUpdateData -> Map PatchPath PatchErrors
export const mergeErrors = R.curry((prevErrors, nextErrors) =>
  R.compose(
    R.reject(haveNoAnyErrors),
    R.cond([
      [
        () => R.propEq('policy', UPDATE_ERRORS_POLICY.MERGE, nextErrors),
        R.mergeDeepRight(prevErrors),
      ],
      [
        () => R.propEq('policy', UPDATE_ERRORS_POLICY.ASSOC, nextErrors),
        R.compose(
          R.reduce(
            (acc, [patchPath, patchErrors]) =>
              R.assoc(patchPath, patchErrors, acc),
            prevErrors
          ),
          R.toPairs
        ),
      ],
      [R.T, R.identity],
    ]),
    R.prop('errors')
  )(nextErrors)
);

// :: [NodeValidateFn] -> [PinValidateFn] -> [LinkValidateFn] ->  Action -> Project -> Map PatchPath DeducedPinTypes -> Map PatchPath PatchErrors -> ErrorsUpdateData
export const validateChangedPatch = R.curry(
  (
    nodeValidators,
    pinValidators,
    linkValidators,
    action,
    project,
    allDeducedPinTypes,
    prevErrors
  ) => {
    const validateFn = validatePatches(
      [R.always({}), ...nodeValidators],
      [R.always({}), ...pinValidators],
      [R.always([]), ...linkValidators]
    );

    const maybePatchPath = getActingPatchPath(action);
    if (Maybe.isJust(maybePatchPath)) {
      const patchPath = explodeMaybe('IMPOSSIBLE ERROR', maybePatchPath);
      return R.compose(
        setMergePolicy,
        validateFn(project, allDeducedPinTypes, prevErrors),
        R.of,
        XP.getPatchByPathUnsafe
      )(patchPath, project);
    }

    return validateAllPatches(project, allDeducedPinTypes, prevErrors);
  }
);

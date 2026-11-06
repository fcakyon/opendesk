// The engine every database view uses to read, compute, filter, sort, group and sum up
// rows (contracts/wiki.md "Databases"). Pure: no React, no DOM, no network.

export { relatedContext, type DbContext, type DbTicketRef } from "./context";
export {
  cellText,
  cellTexts,
  cellValue,
  COMPUTED_TYPES,
  isDateRange,
  isEmpty,
  kindOfType,
  kindOfValue,
  numberFormatOf,
  optionOf,
  relatedRows,
  resultKind,
  rollupSource,
  statusGroupOf,
  type CellValue,
  type DateRange,
  type ValueKind,
} from "./values";
export { fold, formatCount, formatDate, formatDays, formatNumber, formatPercent } from "./format";
export { evaluateFormula, FORMULA_FUNCTIONS, isFormulaError, MAX_FORMULA_LENGTH, parseFormula, type FormulaAst, type FormulaResult, type ParseResult } from "./formula";
export { FILTER_OPS, filterDefaults, filterOpsFor, filterRows, matchesFilter, RELATIVE_DATES, relativeRange, searchRows, type RelativeDate } from "./filter";
export { compareKeys, sortKey, sortRows, type SortKey } from "./sort";
export { dateBucket, groupRows, NO_VALUE, type DateBucket, type Group } from "./group";
export { CALCS_FOR, calcsFor, calculate, rollup, type AggregateFn } from "./calc";
export {
  addOption,
  addProperty,
  changePropertyType,
  defaultValueFor,
  defaultView,
  newOptionId,
  newPropId,
  newViewId,
  nextTone,
  removeProperty,
  TONE_ORDER,
  visibleProps,
  type StatusNames,
} from "./schema";

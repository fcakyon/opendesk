package imports

// The contacts import reads the same files as the ticket import (contracts/imports.md
// "Contacts"), so it shares their reader instead of keeping a second one.

// CSVFile is a parsed CSV file: its header and rows, with the line each row started on.
type CSVFile = csvFile

// MaxCSVBytes bounds the size of a CSV file.
const MaxCSVBytes = maxCSVBytes

// ParseCSV reads a CSV file: UTF-8 or UTF-16 with a byte order mark, separated by commas,
// semicolons or tabs, with a header row.
func ParseCSV(raw []byte) (*CSVFile, error) { return parseCSV(raw) }

// NormHeader lowers a column name and folds its separators, so "E-mail" and "e mail" match.
func NormHeader(h string) string { return normHeader(h) }

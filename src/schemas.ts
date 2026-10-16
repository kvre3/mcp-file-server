import { z } from "zod";

export const listFilesSchema = {
  path: z.string().default(".").describe("Directory relative to workspace root"),
  depth: z.number().int().min(1).max(3).default(1).describe("How many levels to descend (1-3)"),
};

export const readFileSchema = {
  path: z.string().describe("File path relative to workspace root"),
  offset: z.number().int().min(1).default(1).describe("1-based line to start from"),
  limit: z.number().int().min(1).max(500).default(200).describe("Max lines to return (1-500)"),
};

export const writeFileSchema = {
  path: z.string().describe("File path relative to workspace root"),
  content: z.string().describe("Full new content of the file"),
};

export const appendFileSchema = {
  path: z.string().describe("File path relative to workspace root (created if missing)"),
  content: z.string().max(20_000).describe("Text to add at the end of the file (max 20,000 chars)"),
};

export const strReplaceSchema = {
  path: z.string().describe("File path relative to workspace root"),
  old_str: z.string().min(1).describe("Exact text to replace. Must occur exactly once in the file"),
  new_str: z.string().describe("Replacement text (may be empty to delete old_str)"),
};

export const deleteFileSchema = {
  path: z.string().describe("File path relative to workspace root"),
  confirm: z.boolean().default(false).describe("Must be true or the delete is refused"),
};

export const searchFilesSchema = {
  query: z.string().min(1).max(200).describe("Plain text to search for (not a regex)"),
  path: z.string().default(".").describe("File or directory to search, relative to workspace root"),
  max_results: z.number().int().min(1).max(50).default(20).describe("Max matching lines (1-50)"),
  case_sensitive: z.boolean().default(false).describe("Match case exactly"),
};

export const gitCommitSchema = {
  message: z.string().min(1).max(200).describe("Commit message (1-200 chars)"),
  paths: z.array(z.string()).max(50).optional().describe("Files to stage; omit to stage all changes"),
};

export const gitLogSchema = {
  limit: z.number().int().min(1).max(50).default(10).describe("How many commits to show (1-50)"),
};

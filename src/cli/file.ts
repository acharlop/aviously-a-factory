import { loadProject } from "../config/load.ts";
import { fileMemo } from "../steps/file/v1/memo.ts";
import { type Filing, filing } from "../steps/file/v1/record.ts";
import { fileTimesheet } from "../steps/file/v1/timesheet.ts";

/** A command that files one kind of record through the project's file step. */
const filed =
  (file: (args: readonly string[], where: Filing) => number) =>
  async (args: string[]): Promise<number> => {
    const where = filing(await loadProject());
    if (typeof where === "string") {
      console.log(where);
      return 0;
    }
    return file(args, where);
  };

export const timesheet = filed(fileTimesheet);
export const memo = filed(fileMemo);

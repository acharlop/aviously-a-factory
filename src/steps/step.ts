/** One numbered implementation of a step. New behaviour gets a new number; fixes land in place. */
export type StepVersion = {
  name: string;
  version: number;
  summary: string;
  /** The plugin agent (agents/<agent>.md) that runs this version, when an agent does. */
  agent?: string;
  /** Why to move off it and to what; a deprecated version still runs until the next factory major. */
  deprecated?: string;
};

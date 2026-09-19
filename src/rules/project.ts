import { z } from "zod";

/** Schema of `.aicommit.json`, the highest-priority source of project rules. */
export const ProjectConfigSchema = z.object({
  language: z.string().optional(),
  instructions: z.string().optional(),
  style: z.enum(["conventional", "free"]).optional(),
  types: z.array(z.string()).optional(),
  scopes: z.array(z.string()).optional(),
  maxHeaderLength: z.number().int().positive().optional(),
});
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

export function parseProjectConfig(json: string): ProjectConfig {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch (err) {
    throw new Error(`Invalid .aicommit.json: ${(err as Error).message}`);
  }
  const r = ProjectConfigSchema.safeParse(data);
  if (!r.success) {
    const issue = r.error.issues[0]!;
    throw new Error(`Invalid .aicommit.json at "${issue.path.join(".")}": ${issue.message}`);
  }
  return r.data;
}

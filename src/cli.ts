#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { Command } from "commander";
import { extractSpec } from "./extract.js";
import type { Transcript } from "./types.js";

const program = new Command();

program
  .name("shruti")
  .description("Meeting agent — turn transcripts into spec.json")
  .version("0.1.0");

program
  .command("extract <transcript>")
  .description("Read a transcript JSON file and write a spec JSON to stdout")
  .action(async (transcriptPath: string) => {
    const raw = await readFile(transcriptPath, "utf8");
    const transcript = JSON.parse(raw) as Transcript;
    const spec = extractSpec(transcript);
    process.stdout.write(JSON.stringify(spec, null, 2) + "\n");
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  process.stderr.write(`shruti: ${(err as Error).message ?? err}\n`);
  process.exit(1);
});

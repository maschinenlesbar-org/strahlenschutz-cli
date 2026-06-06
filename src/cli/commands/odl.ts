import type { Command } from "commander";
import type { CliDeps } from "../io.js";
import { action, assertEnum, parseIntArg, renderJson } from "../shared.js";
import type { FeatureQuery } from "../../client/types.js";

const RESOLUTIONS = ["ts-1h", "ts-24h"] as const;

/** Pull the shared query options off a parsed-options object. */
function queryFrom(opts: Record<string, unknown>): FeatureQuery {
  return {
    sortBy: opts["sort"] as string | undefined,
    maxFeatures: opts["max"] as number | undefined,
    startIndex: opts["start"] as number | undefined,
  };
}

function addQueryOptions(cmd: Command): Command {
  return cmd
    .option("--max <n>", "max features to return", parseIntArg)
    .option("--start <n>", "offset for paging", parseIntArg)
    .option("--sort <prop>", 'sort by a property (append "+D" for descending)');
}

export function registerOdlCommands(program: Command, deps: CliDeps): void {
  addQueryOptions(
    program
      .command("latest")
      .description("Latest ambient gamma dose-rate (ODL) reading per station")
      .option("--station <kenn>", "restrict to one station by its kenn id"),
  ).action(
    action(deps, async ({ client, global, opts }) => {
      renderJson(
        deps,
        global,
        await client.latest({ ...queryFrom(opts), station: opts["station"] as string | undefined }),
      );
    }),
  );

  program
    .command("station <kenn>")
    .description("Latest reading for a single station by its kenn id")
    .action(
      action(deps, async ({ client, global }, [kenn]) => {
        renderJson(deps, global, await client.station(kenn!));
      }),
    );

  addQueryOptions(
    program
      .command("timeseries <kenn>")
      .description("Time series for a station (hourly by default)")
      .option("--resolution <res>", "ts-1h | ts-24h", "ts-1h"),
  ).action(
    action(deps, async ({ client, global, opts }, [kenn]) => {
      const resolution = assertEnum(String(opts["resolution"]), RESOLUTIONS, "resolution");
      renderJson(deps, global, await client.timeseries(kenn!, resolution, queryFrom(opts)));
    }),
  );
}

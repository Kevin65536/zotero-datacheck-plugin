import { existsSync } from "node:fs";
import { cp, mkdir, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { defineConfig } from "zotero-plugin-scaffold";
import pkg from "./package.json";

const TEST_PROFILE_DIR = ".scaffold/test/profile";
const TEST_DATA_DIR = ".scaffold/test/data";
const TEST_PROFILE_FIXTURE_DIR = "test/fixtures/profile";
const TEST_DATA_FIXTURE_DIR = "test/fixtures/data";
const IGNORED_TEST_SEED_ENTRIES = new Set([
  ".gitkeep",
  "parent.lock",
  ".parentlock",
  "lock",
]);
const USE_DEVELOPMENT_TEST_SEED =
  process.env.ZOTERO_PLUGIN_TEST_USE_DEVELOPMENT_SEED === "1";

function readEnvPath(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function resolveFixturePath(path: string): string | undefined {
  const resolvedPath = resolve(path);
  return existsSync(resolvedPath) ? resolvedPath : undefined;
}

function resolveTestSeedPlan() {
  const explicitProfileSeed = readEnvPath(
    "ZOTERO_PLUGIN_TEST_PROFILE_SEED_PATH",
  );
  const explicitDataSeed = readEnvPath("ZOTERO_PLUGIN_TEST_DATA_SEED_PATH");
  const fixtureProfileSeed = resolveFixturePath(TEST_PROFILE_FIXTURE_DIR);
  const fixtureDataSeed = resolveFixturePath(TEST_DATA_FIXTURE_DIR);
  const developmentProfileSeed = readEnvPath("ZOTERO_PLUGIN_PROFILE_PATH");
  const developmentDataSeed = readEnvPath("ZOTERO_PLUGIN_DATA_DIR");
  const profileSeedPath = explicitProfileSeed
    ? explicitProfileSeed
    : USE_DEVELOPMENT_TEST_SEED
      ? (developmentProfileSeed ?? fixtureProfileSeed)
      : (fixtureProfileSeed ?? developmentProfileSeed);
  const dataSeedPath = explicitDataSeed
    ? explicitDataSeed
    : USE_DEVELOPMENT_TEST_SEED
      ? (developmentDataSeed ?? fixtureDataSeed)
      : (fixtureDataSeed ?? developmentDataSeed);

  return {
    profileSeedPath,
    dataSeedPath,
    usedDevelopmentProfileFallback:
      !explicitProfileSeed && profileSeedPath === developmentProfileSeed,
    usedDevelopmentDataFallback:
      !explicitDataSeed && dataSeedPath === developmentDataSeed,
    usingDevelopmentSeedOverride: USE_DEVELOPMENT_TEST_SEED,
  };
}

async function copyDirectoryContents(
  sourceDir: string | undefined,
  targetDir: string,
): Promise<boolean> {
  if (!sourceDir) {
    return false;
  }

  if (!existsSync(sourceDir)) {
    throw new Error(`Zotero test seed directory not found: ${sourceDir}`);
  }

  await mkdir(targetDir, { recursive: true });
  const entries = await readdir(sourceDir, { withFileTypes: true });

  for (const entry of entries) {
    if (IGNORED_TEST_SEED_ENTRIES.has(entry.name)) {
      continue;
    }

    await cp(resolve(sourceDir, entry.name), resolve(targetDir, entry.name), {
      recursive: true,
      force: true,
    });
  }

  return true;
}

export default defineConfig({
  source: ["src", "addon"],
  dist: ".scaffold/build",
  name: pkg.config.addonName,
  id: pkg.config.addonID,
  namespace: pkg.config.addonRef,
  updateURL: `https://github.com/{{owner}}/{{repo}}/releases/download/release/${
    pkg.version.includes("-") ? "update-beta.json" : "update.json"
  }`,
  xpiDownloadLink:
    "https://github.com/{{owner}}/{{repo}}/releases/download/v{{version}}/{{xpiName}}.xpi",

  build: {
    assets: ["addon/**/*.*"],
    define: {
      ...pkg.config,
      author: pkg.author,
      description: pkg.description,
      homepage: pkg.homepage,
      buildVersion: pkg.version,
      buildTime: "{{buildTime}}",
    },
    prefs: {
      prefix: pkg.config.prefsPrefix,
    },
    esbuildOptions: [
      {
        entryPoints: ["src/index.ts"],
        define: {
          __env__: `"${process.env.NODE_ENV}"`,
        },
        bundle: true,
        target: "firefox115",
        outfile: `.scaffold/build/addon/content/scripts/${pkg.config.addonRef}.js`,
      },
    ],
  },

  test: {
    waitForPlugin: `() => Zotero.${pkg.config.addonInstance}.data.initialized`,
    hooks: {
      "test:init": async (ctx) => {
        const seedPlan = resolveTestSeedPlan();
        const copiedProfile = await copyDirectoryContents(
          seedPlan.profileSeedPath,
          TEST_PROFILE_DIR,
        );
        const copiedData = await copyDirectoryContents(
          seedPlan.dataSeedPath,
          TEST_DATA_DIR,
        );

        if (copiedProfile || copiedData) {
          ctx.logger.info(
            `Prepared isolated Zotero test data from ${copiedProfile ? seedPlan.profileSeedPath : "no profile seed"} and ${copiedData ? seedPlan.dataSeedPath : "no data seed"}.`,
          );
        } else {
          ctx.logger.info(
            "No Zotero test seed was configured. npm test will run against an empty isolated library.",
          );
        }

        if (
          seedPlan.usedDevelopmentProfileFallback ||
          seedPlan.usedDevelopmentDataFallback
        ) {
          ctx.logger.warn(
            "Falling back to ZOTERO_PLUGIN_PROFILE_PATH/ZOTERO_PLUGIN_DATA_DIR for test seeding. Prefer dedicated ZOTERO_PLUGIN_TEST_* seed paths or committed test/fixtures snapshots to keep npm test fast and deterministic.",
          );
        }

        if (seedPlan.usingDevelopmentSeedOverride) {
          ctx.logger.info(
            "ZOTERO_PLUGIN_TEST_USE_DEVELOPMENT_SEED=1 is set, so npm test prefers the development profile/data paths over committed fixtures.",
          );
        }
      },
    },
  },

  // If you need to see a more detailed log, uncomment the following line:
  // logLevel: "trace",
});

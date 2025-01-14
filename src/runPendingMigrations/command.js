import path from 'path';
import fs from 'fs';
import ora from 'ora';
import ApiException from '../ApiException';

import SiteClient from '../site/SiteClient';
import upsertMigrationModel from './upsertMigrationModel';

const MIGRATION_FILE_REGEXP = /^[0-9]+.*\.js$/;

async function catchPermissionErrors(operation, promise) {
  try {
    const result = await promise;
    return result;
  } catch (e) {
    if (e instanceof ApiException && e.statusCode === 401) {
      process.stderr.write(
        `\n\nFail: the API token has not enough permissions to perform the following operation: ${operation}. Please use another API token, or edit the permissions for the current one.\n`,
      );
      process.exit(1);
    }

    throw e;
  }
}

export default async function runPendingMigrations({
  sourceEnvId,
  destinationEnvId: rawDestinationEnvId,
  migrationModelApiKey,
  relativeMigrationsDir,
  inPlace,
  dryRun,
  jsonOutput,
  cmaBaseUrl,
  token: tokenByArg,
}) {
  const jsonResult = {};

  const migrationsDir = path.resolve(relativeMigrationsDir);

  if (!fs.existsSync(migrationsDir)) {
    throw new Error(`Error: ${relativeMigrationsDir} is not a directory!\n`);
  }

  const allMigrations = fs
    .readdirSync(migrationsDir)
    .filter(file => file.match(MIGRATION_FILE_REGEXP));

  const token = tokenByArg || process.env.DATO_MANAGEMENT_API_TOKEN;

  const globalClient = new SiteClient(token, { baseUrl: cmaBaseUrl });

  const allEnvironments = await catchPermissionErrors(
    'fetch the existing environments',
    globalClient.environments.all(),
  );

  const primaryEnv = allEnvironments.find(env => env.meta.primary);

  const sourceEnv = sourceEnvId
    ? await catchPermissionErrors(
        `fetch environment ${sourceEnvId}`,
        globalClient.environments.find(sourceEnvId),
      )
    : primaryEnv;

  if (!sourceEnv) {
    throw new Error(
      `You have no permissions to access the ${
        sourceEnvId ? `"${sourceEnvId}"` : 'primary'
      } environment!`,
    );
  }

  let destinationEnvId = inPlace
    ? sourceEnv.id
    : rawDestinationEnvId || `${sourceEnv.id}-post-migrations`;

  if (inPlace) {
    if (primaryEnv && primaryEnv.id === destinationEnvId) {
      throw new Error(
        'Running migrations on primary environment is not allowed!',
      );
    }
  } else {
    const forkSpinner = ora(
      `Creating a fork of \`${sourceEnv.id}\` called \`${destinationEnvId}\`...`,
    ).start();

    const existingEnvironment = allEnvironments.find(
      env => env.id === destinationEnvId,
    );

    if (existingEnvironment) {
      forkSpinner.fail();
      throw new Error(
        `Environment ${destinationEnvId} already exists! If you want to run the migrations inside this existing environment you can add the --inPlace flag.`,
      );
    }

    if (dryRun) {
      destinationEnvId = sourceEnv.id;
    } else {
      await catchPermissionErrors(
        `fork environment ${sourceEnv.id} into ${destinationEnvId}`,
        globalClient.environments.fork(sourceEnv.id, {
          id: destinationEnvId,
        }),
      );
    }

    forkSpinner.succeed();
  }

  jsonResult.destinationEnvId = destinationEnvId;

  if (!jsonOutput) {
    process.stdout.write(
      `Migrations will be run in sandbox env \`${destinationEnvId}\`\n`,
    );
  }

  const client = new SiteClient(token, {
    environment: destinationEnvId,
    baseUrl: cmaBaseUrl,
  });

  const migrationModel = await upsertMigrationModel(
    client,
    migrationModelApiKey,
    catchPermissionErrors,
    dryRun,
  );

  const alreadyRunMigrations = migrationModel
    ? (
        await client.items.all(
          { filter: { type: migrationModel.id } },
          { allPages: true },
        )
      ).map(m => m.name)
    : [];

  const migrationsToRun = allMigrations
    .filter(file => !alreadyRunMigrations.includes(file))
    .sort();

  for (const migrationFile of migrationsToRun) {
    const migrationSpinner = ora(`Running ${migrationFile}...`).start();

    if (!dryRun) {
      const migrationAbsolutePath = path.join(migrationsDir, migrationFile);
      // eslint-disable-next-line global-require, import/no-dynamic-require
      const migration = require(migrationAbsolutePath);
      await migration(client);
    }

    migrationSpinner.succeed();

    if (!dryRun) {
      await client.items.create({
        itemType: migrationModel.id,
        name: migrationFile,
      });
    }
  }

  jsonResult.runMigrations = migrationsToRun;
  jsonResult.runMigrationsCount = migrationsToRun.length;

  if (!jsonOutput) {
    process.stdout.write(
      `Done! Successfully run ${migrationsToRun.length} migration files.\n`,
    );
  }

  if (jsonOutput) {
    process.stdout.write(JSON.stringify(jsonResult, null, 2));
  }
}

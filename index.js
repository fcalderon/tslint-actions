"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const core = require("@actions/core"); // tslint:disable-line
// Currently @actions/github cannot be loaded via import statement due to typing error
const github = require("@actions/github"); // tslint:disable-line
const common_tags_1 = require("common-tags");
const fs = require("fs");
const glob = require("glob");
const path = require("path");
const tslint_1 = require("tslint");
const CHECK_NAME = "TSLint Checks";
const findChangedFiles = async (ctx, octokit, pattern) => {
    let files = glob.sync(pattern);
    const pullRequest = ctx.payload.pull_request;
    // tslint:disable-next-line:no-console
    console.log("Is this pull request?", !!pullRequest);
    if (pullRequest) {
        const response = await octokit.pulls.listFiles({
            owner: ctx.repo.owner,
            repo: ctx.repo.repo,
            pull_number: pullRequest.number,
        });
        const changedFiles = response.data.map((f) => f.filename);
        files = files.filter((f) => changedFiles.includes(f));
        // tslint:disable-next-line:no-console
        console.log("List of files in pull request:", files.length);
        // tslint:disable-next-line:no-console
        console.log("List of files in pull request (2):", changedFiles.length);
    }
    else {
        const response = await octokit.pulls.listFiles({
            owner: ctx.repo.owner,
            repo: ctx.repo.repo,
            pull_number: (await octokit.repos.listPullRequestsAssociatedWithCommit({
                owner: ctx.repo.owner,
                repo: ctx.repo.repo,
                commit_sha: ctx.sha,
            })).data[0].number,
        });
        const changedFiles = response.data.map((f) => f.filename);
        files = files.filter((f) => changedFiles.includes(f));
        // tslint:disable-next-line:no-console
        console.log("List of files in commit:", files.length);
        // tslint:disable-next-line:no-console
        console.log("List of files in pull commit (2):", changedFiles.length);
    }
    return files;
};
const SeverityAnnotationLevelMap = new Map([
    ["warning", "warning"],
    ["error", "failure"],
]);
(async () => {
    const ctx = github.context;
    const configFileName = core.getInput("config") || "tslint.json";
    const projectFileName = core.getInput("project");
    const pattern = core.getInput("pattern");
    const ghToken = core.getInput("token");
    const onlyChangedFiles = core.getInput("only-changed-files") || false;
    if (!projectFileName && !pattern) {
        core.setFailed("tslint-actions: Please set project or pattern input");
        return;
    }
    if (!ghToken) {
        core.setFailed("tslint-actions: Please set token");
        return;
    }
    const octokit = new github.GitHub(ghToken);
    // Create check
    const check = await octokit.checks.create({
        owner: ctx.repo.owner,
        repo: ctx.repo.repo,
        name: CHECK_NAME,
        head_sha: ctx.payload.pull_request ? ctx.payload.pull_request.head.sha : ctx.sha,
        status: "in_progress",
    });
    const options = {
        fix: false,
        formatter: "json",
    };
    // Create a new Linter instance
    const result = await (async () => {
        if (projectFileName && !pattern) {
            const projectDir = path.dirname(path.resolve(projectFileName));
            const program = tslint_1.Linter.createProgram(projectFileName, projectDir);
            const linter = new tslint_1.Linter(options, program);
            const files = tslint_1.Linter.getFileNames(program);
            for (const file of files) {
                const sourceFile = program.getSourceFile(file);
                if (sourceFile) {
                    const fileContents = sourceFile.getFullText();
                    const configuration = tslint_1.Configuration.findConfiguration(configFileName, file).results;
                    linter.lint(file, fileContents, configuration);
                }
            }
            return linter.getResult();
        }
        else {
            const linter = new tslint_1.Linter(options);
            let files = [];
            if (onlyChangedFiles) {
                files = await findChangedFiles(ctx, octokit, pattern);
            }
            else {
                files = glob.sync(pattern);
            }
            for (const file of files) {
                const fileContents = fs.readFileSync(file, { encoding: "utf8" });
                const configuration = tslint_1.Configuration.findConfiguration(configFileName, file).results;
                linter.lint(file, fileContents, configuration);
            }
            return linter.getResult();
        }
    })();
    const annotations = result.failures.map((failure) => ({
        path: failure.getFileName(),
        start_line: failure.getStartPosition().getLineAndCharacter().line,
        end_line: failure.getEndPosition().getLineAndCharacter().line,
        annotation_level: SeverityAnnotationLevelMap.get(failure.getRuleSeverity()) || "notice",
        message: `[${failure.getRuleName()}] ${failure.getFailure()}`,
    }));
    // Update check
    await octokit.checks.update({
        owner: ctx.repo.owner,
        repo: ctx.repo.repo,
        check_run_id: check.data.id,
        name: CHECK_NAME,
        status: "completed",
        conclusion: result.errorCount > 0 ? "failure" : "success",
        output: {
            title: CHECK_NAME,
            summary: `${result.errorCount} error(s), ${result.warningCount} warning(s) found`,
            text: common_tags_1.stripIndent `
        ## Configuration

        #### Actions Input

        | Name | Value |
        | ---- | ----- |
        | config | \`${configFileName}\` |
        | project | \`${projectFileName || "(not provided)"}\` |
        | pattern | \`${pattern || "(not provided)"}\` |

        #### TSLint Configuration

        \`\`\`json
        __CONFIG_CONTENT__
        \`\`\`
        </details>
      `.replace("__CONFIG_CONTENT__", JSON.stringify(tslint_1.Configuration.readConfigurationFile(configFileName), null, 2)),
            annotations,
        },
    });
})().catch((e) => {
    console.error(e.stack); // tslint:disable-line
    core.setFailed(e.message);
});

import listContent from "list-github-dir-content";
import { escapeFilepath, URL_PARSER_REGEX } from "../utils/utils";
import fs from "fs";
import { listDirFilesRecursive } from "./files";

const DEFAULT_CONCURRENCY = 100;
export type FilesResponse<T> = Map<string, T>;

type DownloadOptions = {
  //numbers of files to download in batch
  concurrency?: number;
  //returns whether the file is cached or not
  isCached?: (filePath: string) => boolean;
  //attempt get file from local env
  attempLocal?: boolean;
  //root of the repository
  localBasePath?: string;
  //local folder to find contracts
  localFolderPath?: string;
  //recursive folder download
  recursive?: boolean;
};

const defaultOptions: DownloadOptions = {
  concurrency: DEFAULT_CONCURRENCY,
  isCached: (_: string) => false,
  attempLocal: false,
  localBasePath: "",
  localFolderPath: "",
  recursive: true,
};

type File = {
  path: string;
};

type ParsedURL = {
  user: string;
  repository: string;
  ref: string;
  dir: string;
};

function parseGithubURL(url: URL): ParsedURL {
  const parsedUrl = URL_PARSER_REGEX.exec(url.pathname);
  if (!parsedUrl) {
    throw new Error("URL is not valid.");
  }
  const [, user, repository, ref, dir] = parsedUrl;
  return {
    user,
    repository,
    ref,
    dir,
  };
}

export async function listFilesFromDirectory(
  url: URL,
  recursive = true
): Promise<File[]> {
  const { user, repository, ref, dir } = parseGithubURL(url);

  return listContent.viaContentsApi({
    user,
    repository,
    ref,
    directory: decodeURIComponent(dir),
    getFullData: true,
  }) as Promise<File[]>;
}

export async function fetchPublicFile<T>(
  baseURL: URL,
  filePath: string,
  controller?: AbortController
) {
  const { user, repository, ref } = parseGithubURL(baseURL);

  const response = await fetch(
    `https://raw.githubusercontent.com/${user}/${repository}/${ref}/${escapeFilepath(
      filePath
    )}`,
    {
      signal: controller ? controller.signal : undefined,
    }
  );

  if (!response.ok) {
    throw new Error(`HTTP ${response.statusText} for ${filePath}`);
  }

  const fileContent = await response.text();
  const parsedFile = JSON.parse(fileContent);
  return parsedFile as T;
}

export async function downloadAllDirectoryFilesFromURL<T>(
  url: URL,
  options: DownloadOptions = defaultOptions
): Promise<FilesResponse<T>> {
  let files: File[] | undefined;
  try {
    if (options.localBasePath && fs.existsSync(options.localBasePath)) {
      const localFiles = listDirFilesRecursive(
        options.localBasePath,
        options.localFolderPath || ""
      );
      files = localFiles.map((localFile) => ({
        path: localFile,
      }));
    }
  } catch (e) {
    console.warn("Something went wrong while parsing local files", e);
  }

  if (!files) {
    files = await listFilesFromDirectory(url, options.recursive ?? true);
  }

  const controller = new AbortController();

  const ret: FilesResponse<T> = new Map<string, T>();

  let quantity = 0;
  let quantityToProcess = files.length;
  const fetchFile = async (file: File) => {
    if (options.isCached && options.isCached(file.path)) {
      quantity++;
      return;
    }

    let fileContent: T | null = null;
    try {
      if (options.attempLocal && options.localBasePath) {
        const localPath = `${options.localBasePath}/${file.path}`;
        if (fs.existsSync(localPath)) {
          fileContent = JSON.parse(fs.readFileSync(localPath, "utf-8"));
        }
      }

      if (!fileContent) {
        fileContent = await fetchPublicFile<T>(url, file.path, controller);
      }

      if (fileContent) {
        ret.set(file.path, fileContent);
      }
    } catch (e) {
      return;
    }

    quantity += 1;
    if (quantity % 100 === 0) {
      console.log(`Feched ${quantity} of ${quantityToProcess} files.`);
    }

    return;
  };

  console.log(`Fetching ${quantityToProcess} files`);
  while (files.length) {
    await Promise.all(
      files.splice(0, options.concurrency || DEFAULT_CONCURRENCY).map(fetchFile)
    );
  }

  console.log(`Fetched ${quantity} of ${quantityToProcess} files`);

  return ret;
}

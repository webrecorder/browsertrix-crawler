import { getDirSize } from "./util/storage.js";
import fs from "fs";
import path from "path";

const __dirname = path.resolve();

describe("getDirSize function with size limit", () => {
  it("should return the correct size of a directory up to the specified limit", async () => {
    // Create a directory with files of known content
    const dir = await fs.promises.mkdtemp(path.join(__dirname, "test-"));
    const file1 = path.join(dir, "file1.txt");
    const file2 = path.join(dir, "file2.txt");
    const file3 = path.join(dir, "file3.txt");
    const fileContent = "abcdefghijklmnopqrstuvwxyz\n";

    await fs.promises.writeFile(file1, fileContent);
    await fs.promises.writeFile(file2, fileContent);
    await fs.promises.writeFile(file3, fileContent);
  
    // Check the size of the directory with a limit
    const sizeLimit = 241; // bytes
    const size = await getDirSize(dir, sizeLimit);
  
    // Assert that the size is correct
    expect(size).toBe(sizeLimit);
  
    // Cleanup
    await fs.promises.unlink(file1);
    await fs.promises.unlink(file2);
    await fs.promises.unlink(file3);
    await fs.promises.rmdir(dir);
  });
});

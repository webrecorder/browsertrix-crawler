export class Job
{
  constructor(data, callbacks) {
    this.data = data;
    this.callbacks = callbacks;
  }

  getUrl() {
    if (!this.data) {
      return undefined;
    }
    if (typeof this.data === "string") {
      return this.data;
    }
    if (typeof (this.data).url === "string") {
      return (this.data).url;
    }
    return undefined;
  }
}

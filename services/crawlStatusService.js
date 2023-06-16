import {mysqlClient} from "./mysqlClient.js";

export class CrawlStatusService{
  constructor() {
  }

  insertCrawl(url, domain, level){
    const sql = "insert into ? (domain, url, level, status) values ('?', '?', ?, 0)";
    const values = [url, domain, level];
    mysqlClient.query(sql, values);
  }

  updateCrawlStatus
}
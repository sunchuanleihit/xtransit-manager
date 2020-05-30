'use strict';

const moment = require('moment');
const pMap = require('p-map');
const Service = require('egg').Service;

class RedisService extends Service {
  composeClientsKey(appId) {
    const { ctx: { app: { config: { clientsPrefix } } } } = this;
    const key = `${clientsPrefix}${appId}`;
    return key;
  }

  composeClientsField(agentId) {
    return agentId;
  }

  composeLogsKey(appId, agentId) {
    const { ctx: { app: { config: { logsPrefix } } } } = this;
    const key = `${logsPrefix}${appId}::${agentId}`;
    return key;
  }

  composeLogsField(filePath) {
    return filePath;
  }

  composeErrorLogKey(errorLogPath) {
    const { ctx: { app: { config: { errorLogPrefix } } } } = this;
    const key = `${errorLogPrefix}${errorLogPath}`;
    return key;
  }

  composePackageKey(packagePath) {
    const { ctx: { app: { config: { packagePrefix } } } } = this;
    const key = `${packagePrefix}${packagePath}`;
    return key;
  }

  getExpiredTime(type) {
    return type === 'package' ? 24 * 60 * 60 : 5 * 60;
  }

  checkExpired(timestamp, expired = 300) {
    return !timestamp || Date.now() - timestamp > expired * 1000;
  }

  async cleanExpiredXtransit() {
    const { ctx: { app: { redis, config: { appsKey } } } } = this;
    const livingApps = await redis.smembers(appsKey);
    await pMap(livingApps, async appId => {
      const key = this.composeClientsKey(appId);
      // clean expired agents
      const agentIds = await redis.hgetall(key);
      let length = 0;
      await pMap(Object.entries(agentIds), async ([agentId, agentInfo]) => {
        length++;
        const { timestamp } = JSON.parse(agentInfo);
        if (this.checkExpired(timestamp)) {
          const field = this.composeClientsField(agentId);
          await redis.hdel(key, field);
          length--;
        }
      }, { concurrency: 2 });

      // check app is still living
      if (length === 0) {
        await redis.srem(appsKey, appId);
      }
    }, { concurrency: 2 });
  }

  async cleanExpiredFile() {
    const { ctx: { app: { redis, config: { logsKey } } } } = this;
    const livingFiles = await redis.smembers(logsKey);
    await pMap(livingFiles, async key => {
      const files = await redis.hgetall(key);
      let length = 0;
      await pMap(Object.entries(files), async ([filePath, fileInfo]) => {
        length++;
        const { type, timestamp } = JSON.parse(fileInfo);
        const expired = this.getExpiredTime(type);
        if (this.checkExpired(timestamp, expired)) {
          const field = this.composeLogsField(filePath);
          await redis.hdel(key, field);
          const fileKey = type === 'package'
            ? this.composePackageKey(filePath)
            : this.composeErrorLogKey(filePath);
          await redis.del(fileKey);
          length--;
        }
      }, { concurrency: 2 });

      if (length === 0) {
        await redis.srem(logsKey, key);
      }
    }, { concurrency: 2 });
  }

  async handleOldClients(appId, agentId, clientId) {
    const { ctx, ctx: { app: { redis }, service: { xtransit } } } = this;
    try {
      const key = this.composeClientsKey(appId);
      const field = this.composeClientsField(agentId);

      // check old client
      let oldClients = await redis.hget(key, field);
      oldClients = JSON.parse(oldClients);

      if (oldClients) {
        const { clientId: oldClientId, server: oldClientServer } = oldClients;
        if (oldClientId !== clientId) {
          await xtransit.closeClient(oldClientServer, { appId, agentId, oldClientId });
        }
      }
    } catch (err) {
      ctx.logger.error(`[redis] [handleOldClients] falied: ${err}`);
    }
  }

  async updateLivingApp(appId) {
    const { ctx: { app: { redis, config: { appsKey } } } } = this;
    await redis.sadd(appsKey, appId);
  }

  async updateClient(appId, agentId, clientId, server, timestamp) {
    const { ctx: { app: { redis } } } = this;
    // handle old client
    await this.handleOldClients(appId, agentId, clientId);

    // add living app info
    await this.updateLivingApp(appId);

    // add client info
    const key = this.composeClientsKey(appId);
    const field = this.composeClientsField(agentId);
    const value = JSON.stringify({ clientId, server, timestamp });
    await redis.hset(key, field, value);
  }

  async removeClient(appId, agentId, clientId) {
    const { ctx, ctx: { app: { redis } } } = this;
    const key = this.composeClientsKey(appId);
    const field = this.composeClientsField(agentId);
    let value = await redis.hget(key, field);
    try {
      value = JSON.parse(value);
    } catch (err) {
      ctx.logger.error(`[redis] [removeClient] falied: ${err}`);
      return;
    }
    if (value.clientId === clientId) {
      const tasks = [];
      tasks.push(redis.hdel(key, field));
      await Promise.all(tasks);
    }
  }

  async getClient(appId, agentId) {
    const { ctx, ctx: { app: { redis } } } = this;
    const key = this.composeClientsKey(appId);
    const field = this.composeClientsField(agentId);
    let value = await redis.hget(key, field);
    try {
      value = JSON.parse(value);
    } catch (err) {
      ctx.logger.error(`[redis] [removeClient] falied: ${err}`);
    }
    return value || {};
  }

  async getClients(appId) {
    const { ctx: { app: { redis }, service: { xtransit } } } = this;
    const key = this.composeClientsKey(appId);
    const agents = await redis.hgetall(key);
    if (Object.keys(agents).length === 0) {
      return;
    }
    const map = {};
    for (const [agentId, agentInfo] of Object.entries(agents)) {
      const { server, clientId, timestamp } = JSON.parse(agentInfo);
      if (this.checkExpired(timestamp)) {
        continue;
      }
      const data = { appId, agentId, clientId };
      if (map[server]) {
        map[server].push(data);
      } else {
        map[server] = [data];
      }
    }
    const livingClients = [];
    await pMap(Object.entries(map), async ([server, clients]) => {
      const data = await xtransit.checkClientAlive(server, { clients });
      for (const [index, status] of Object.entries(data)) {
        const clientInfo = clients[Number(index)];
        if (status) {
          livingClients.push(clientInfo);
        } else {
          const { agentId } = clientInfo;
          const field = this.composeClientsField(agentId);
          await redis.hdel(key, field);
        }
      }
    }, { concurrency: 2 });

    return livingClients;
  }

  async updateLogs(appId, agentId, logFile, type) {
    const { ctx: { app: { redis, config: { logsKey } } } } = this;

    const key = this.composeLogsKey(appId, agentId);
    await redis.sadd(logsKey, key);
    const field = this.composeLogsField(logFile);
    const value = JSON.stringify({ type, timestamp: Date.now() });
    await redis.hset(key, field, value);
  }

  async saveErrorLogs(errorLogPath, errorLogs) {
    const { ctx: { app: { redis, config: { errorLogLimit, errorLogStorage } } } } = this;

    // save error logs
    const key = this.composeErrorLogKey(errorLogPath);
    await redis.lpush(key, ...errorLogs.map(log => JSON.stringify(log)));
    await redis.ltrim(key, 0, errorLogLimit - 1);

    // expired
    const date = moment().add(errorLogStorage, 'days');
    const timestamp = date.startOf('day').unix();
    await redis.expireat(key, timestamp);
  }

  async savePackage(packagePath, pkg, lock) {
    const { ctx: { app: { redis, config: { packageStorage } } } } = this;

    // save package
    const key = this.composePackageKey(packagePath);
    await redis.setex(key, packageStorage * 24 * 60 * 60, JSON.stringify({ pkg, lock }));
  }

  async getFiles(appId, agentId, type) {
    const { ctx: { app: { redis } } } = this;
    const key = this.composeLogsKey(appId, agentId);
    const files = await redis.hgetall(key);
    const list = [];
    for (const [filePath, fileInfo] of Object.entries(files)) {
      const { timestamp, type: fileType } = JSON.parse(fileInfo);
      if (fileType !== type) {
        continue;
      }

      const expired = this.getExpiredTime(fileType);
      if (this.checkExpired(timestamp, expired)) {
        continue;
      }

      if (type === 'package') {
        list.push(await this.checkModuleRisk(filePath));
      } else {
        list.push(filePath);
      }
    }

    return list;
  }

  async getErrors(errorLogPath, currentPage, pageSize) {
    const { ctx: { app: { redis } } } = this;
    const key = this.composeErrorLogKey(errorLogPath);
    const count = await redis.llen(key);
    const start = (currentPage - 1) * pageSize;
    const stop = currentPage * pageSize - 1;
    let errors = await redis.lrange(key, start, stop);
    errors = errors.map(log => {
      try {
        log = JSON.parse(log);
        return log;
      } catch (err) {
        return null;
      }
    }).filter(log => log);

    return { count, errors };
  }

  async getModules(packagePath) {
    const { ctx: { app: { redis } } } = this;
    const key = this.composePackageKey(packagePath);
    const { pkg, lock } = JSON.parse(await redis.get(key));
    return {
      pkg: JSON.parse(pkg),
      lock: JSON.parse(lock),
    };
  }

  async checkModuleRisk(packagePath) {
    return packagePath;
  }
}

module.exports = RedisService;

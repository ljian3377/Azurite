import {
  BOOLEAN,
  DATE,
  INTEGER,
  literal,
  Model,
  Op,
  Options as SequelizeOptions,
  Sequelize,
  TEXT
} from "sequelize";
import uuid from "uuid/v4";

import {
  DEFAULT_SQL_CHARSET,
  DEFAULT_SQL_COLLATE
} from "../../common/utils/constants";
import StorageErrorFactory from "../errors/StorageErrorFactory";
import * as Models from "../generated/artifacts/models";
import { BlobType } from "../generated/artifacts/models";
import { LeaseAccessConditions } from "../generated/artifacts/models";
import Context from "../generated/Context";
import {
  DEFAULT_LIST_BLOBS_MAX_RESULTS,
  DEFAULT_LIST_CONTAINERS_MAX_RESULTS
} from "../utils/constants";
import BlobLeaseAdapter from "./BlobLeaseAdapter";
import BlobLeaseSyncer from "./BlobLeaseSyncer";
import BlobReadLeaseValidator from "./BlobReadLeaseValidator";
import BlobReferredExtentsAsyncIterator from "./BlobReferredExtentsAsyncIterator";
import BlobWriteLeaseSyncer from "./BlobWriteLeaseSyncer";
import BlobWriteLeaseValidator from "./BlobWriteLeaseValidator";
import ContainerDeleteLeaseValidator from "./ContainerDeleteLeaseValidator";
import ContainerLeaseAdapter from "./ContainerLeaseAdapter";
import ContainerLeaseSyncer from "./ContainerLeaseSyncer";
import ContainerReadLeaseValidator from "./ContainerReadLeaseValidator";
import IBlobMetadataStore, {
  AcquireBlobLeaseResponse,
  AcquireContainerLeaseResponse,
  BlobId,
  BlobModel,
  BlockModel,
  BreakBlobLeaseResponse,
  BreakContainerLeaseResponse,
  ChangeBlobLeaseResponse,
  ChangeContainerLeaseResponse,
  ContainerModel,
  CreateSnapshotResponse,
  GetBlobPropertiesRes,
  GetContainerAccessPolicyResponse,
  GetContainerPropertiesResponse,
  GetPageRangeResponse,
  IContainerMetadata,
  IExtentChunk,
  PersistencyBlockModel,
  ReleaseBlobLeaseResponse,
  RenewBlobLeaseResponse,
  RenewContainerLeaseResponse,
  ServicePropertiesModel,
  SetContainerAccessPolicyOptions
} from "./IBlobMetadataStore";
import { ILease } from "./ILeaseState";
import LeaseFactory from "./LeaseFactory";

// tslint:disable: max-classes-per-file
class ServicesModel extends Model {}
class ContainersModel extends Model {}
class BlobsModel extends Model {}
class BlocksModel extends Model {}
// class PagesModel extends Model {}

interface IBlobContentProperties {
  contentLength?: number;
  contentType?: string;
  contentEncoding?: string;
  contentLanguage?: string;
  contentMD5?: Uint8Array;
  contentDisposition?: string;
  cacheControl?: string;
}

/*
 * Preparations before starting with Sql based metadata store implementation
 * 1. Setup a database, like MySql, MariaDB, Sql Server or SqlLite
 * 2. (For development) Update database connection configurations under migrations/blob/metadata/config/config.json;
 *    (For production) Update environment variables `AZURITE_DB_USERNAME`, `AZURITE_DB_PASSWORD`, `AZURITE_DB_NAME`,
 *    `AZURITE_DB_HOSTNAME`, `AZURITE_DB_DIALECT`
 * 3. Create a database by `npm run db:create:blob:metadata` or create it manually
 * 4. Migrate database by `npm run db:migrate:blob:metadata`
 *
 * Steps to setup database in docker:
 * - docker run --name mariadb -p 3306:3306 -e MYSQL_ROOT_PASSWORD=my-secret-pw -d mariadb:latest
 *
 * - docker run --name mysql1 -p 3306:3306 -e MYSQL_ROOT_PASSWORD=my-secret-pw -d mysql:latest
 * - docker exec -it mysql1 /bin/bash
 *
 */

/**
 * A SQL based Blob metadata storage implementation based on Sequelize.
 *
 * @export
 * @class SqlBlobMetadataStore
 * @implements {IBlobMetadataStore}
 */
export default class SqlBlobMetadataStore implements IBlobMetadataStore {
  private initialized: boolean = false;
  private closed: boolean = false;
  private readonly sequelize: Sequelize;

  /**
   * Creates an instance of SqlBlobMetadataStore.
   *
   * @param {string} connectionURI For example, "postgres://user:pass@example.com:5432/dbname"
   * @param {SequelizeOptions} [sequelizeOptions]
   * @memberof SqlBlobMetadataStore
   */
  public constructor(
    connectionURI: string,
    sequelizeOptions?: SequelizeOptions
  ) {
    this.sequelize = new Sequelize(connectionURI, sequelizeOptions);
  }

  public async init(): Promise<void> {
    await this.sequelize.authenticate();

    ServicesModel.init(
      {
        accountName: {
          type: "VARCHAR(32)",
          primaryKey: true
        },
        defaultServiceVersion: {
          type: "VARCHAR(10)"
        },
        cors: {
          type: "VARCHAR(4095)"
        },
        logging: {
          type: "VARCHAR(255)"
        },
        minuteMetrics: {
          type: "VARCHAR(255)"
        },
        hourMetrics: {
          type: "VARCHAR(255)"
        },
        staticWebsite: {
          type: "VARCHAR(1023)"
        },
        deleteRetentionPolicy: {
          type: "VARCHAR(255)"
        }
      },
      {
        sequelize: this.sequelize,
        modelName: "Services",
        tableName: "Services",
        timestamps: false
      }
    );

    ContainersModel.init(
      {
        accountName: {
          type: "VARCHAR(32)",
          unique: "accountname_containername"
        },
        // tslint:disable-next-line:max-line-length
        // https://docs.microsoft.com/en-us/rest/api/storageservices/naming-and-referencing-containers--blobs--and-metadata
        containerName: {
          type: "VARCHAR(63)",
          unique: "accountname_containername"
        },
        containerId: {
          type: INTEGER.UNSIGNED,
          primaryKey: true,
          autoIncrement: true
        },
        lastModified: {
          allowNull: false,
          type: DATE(6)
        },
        etag: {
          allowNull: false,
          type: "VARCHAR(127)"
        },
        // TODO: Confirm max length of metadata pairs
        metadata: {
          type: "VARCHAR(4095)"
        },
        containerAcl: {
          type: "VARCHAR(1023)"
        },
        publicAccess: {
          type: "VARCHAR(31)"
        },
        lease: {
          type: "VARCHAR(1023)"
        },
        hasImmutabilityPolicy: {
          type: BOOLEAN
        },
        hasLegalHold: {
          type: BOOLEAN
        }
      },
      {
        sequelize: this.sequelize,
        modelName: "Containers",
        tableName: "Containers",
        charset: DEFAULT_SQL_CHARSET,
        collate: DEFAULT_SQL_COLLATE,
        timestamps: false
      }
    );

    BlobsModel.init(
      {
        accountName: {
          type: "VARCHAR(64)",
          allowNull: false
        },
        containerName: {
          type: "VARCHAR(255)",
          allowNull: false
        },
        // TODO: Check max blob name length
        blobName: {
          type: "VARCHAR(255)",
          allowNull: false
        },
        snapshot: {
          type: "VARCHAR(64)",
          allowNull: false,
          defaultValue: ""
        },
        blobId: {
          type: INTEGER.UNSIGNED,
          primaryKey: true,
          autoIncrement: true
        },
        lastModified: {
          allowNull: false,
          type: DATE(6)
        },
        creationTime: {
          allowNull: false,
          type: DATE(6)
        },
        accessTierChangeTime: {
          allowNull: true,
          type: DATE(6)
        },
        accessTierInferred: {
          type: BOOLEAN
        },
        etag: {
          allowNull: false,
          type: "VARCHAR(127)"
        },
        blobType: {
          allowNull: false,
          type: "VARCHAR(31)"
        },
        blobSequenceNumber: {
          type: "VARCHAR(63)"
        },
        accessTier: {
          type: "VARCHAR(31)"
        },
        contentProperties: {
          type: "VARCHAR(1023)"
        },
        leaseId: {
          type: "VARCHAR(127)"
        },
        leaseStatus: {
          type: "VARCHAR(31)"
        },
        leaseState: {
          type: "VARCHAR(31)"
        },
        leaseDuration: {
          type: "VARCHAR(31)"
        },
        leasedurationNumber: {
          type: "VARCHAR(63)"
        },
        leaseExpireTime: {
          type: DATE(6)
        },
        leaseBreakExpireTime: {
          type: DATE(6)
        },
        deleting: {
          type: INTEGER.UNSIGNED,
          defaultValue: 0, // 0 means container is not under deleting(gc)
          allowNull: false
        },
        isCommitted: {
          type: BOOLEAN,
          allowNull: false
        },
        persistency: {
          type: "VARCHAR(255)"
        },
        committedBlocksInOrder: {
          type: TEXT({ length: "medium" })
        },
        metadata: {
          type: "VARCHAR(2047)"
        }
      },
      {
        sequelize: this.sequelize,
        modelName: "Blobs",
        tableName: "Blobs",
        timestamps: false,
        charset: DEFAULT_SQL_CHARSET,
        collate: DEFAULT_SQL_COLLATE,
        indexes: [
          {
            // name: 'title_index',
            // using: 'BTREE',
            unique: true,
            fields: [
              "accountName",
              "containerName",
              "blobName",
              "snapshot",
              "deleting"
            ]
          }
        ]
      }
    );

    BlocksModel.init(
      {
        accountName: {
          type: "VARCHAR(64)",
          allowNull: false
        },
        containerName: {
          type: "VARCHAR(255)",
          allowNull: false
        },
        blobName: {
          type: "VARCHAR(255)",
          allowNull: false
        },
        // TODO: Check max block name length
        blockName: {
          type: "VARCHAR(64)",
          allowNull: false
        },
        deleting: {
          type: INTEGER.UNSIGNED,
          defaultValue: 0, // 0 means container is not under deleting(gc)
          allowNull: false
        },
        size: {
          type: INTEGER.UNSIGNED,
          allowNull: false
        },
        persistency: {
          type: "VARCHAR(255)"
        }
      },
      {
        sequelize: this.sequelize,
        modelName: "Blocks",
        tableName: "Blocks",
        timestamps: false,
        indexes: [
          {
            fields: ["accountName", "containerName", "blobName", "blockName"]
          }
        ]
      }
    );

    // TODO: sync() is only for development purpose, use migration for production
    await this.sequelize.sync();

    this.initialized = true;
  }

  public isInitialized(): boolean {
    return this.initialized;
  }

  public async close(): Promise<void> {
    await this.sequelize.close();
    this.closed = true;
  }

  public isClosed(): boolean {
    return this.closed;
  }

  public async clean(): Promise<void> {
    // TODO: Implement cleanup in database
  }

  public async setServiceProperties(
    context: Context,
    serviceProperties: ServicePropertiesModel
  ): Promise<ServicePropertiesModel> {
    return this.sequelize.transaction(async t => {
      const findResult = await ServicesModel.findByPk(
        serviceProperties.accountName,
        {
          transaction: t
        }
      );
      const updateValues = {
        defaultServiceVersion: serviceProperties.defaultServiceVersion,
        cors: this.serializeModelValue(serviceProperties.cors),
        logging: this.serializeModelValue(serviceProperties.logging),
        minuteMetrics: this.serializeModelValue(
          serviceProperties.minuteMetrics
        ),
        hourMetrics: this.serializeModelValue(serviceProperties.hourMetrics),
        staticWebsite: this.serializeModelValue(
          serviceProperties.staticWebsite
        ),
        deleteRetentionPolicy: this.serializeModelValue(
          serviceProperties.deleteRetentionPolicy
        )
      };
      if (findResult === null) {
        await ServicesModel.create(
          {
            accountName: serviceProperties.accountName,
            ...updateValues
          },
          { transaction: t }
        );
      } else {
        const updateResult = await ServicesModel.update(updateValues, {
          transaction: t,
          where: {
            accountName: serviceProperties.accountName
          }
        });

        // Set the exactly equal properties will affect 0 rows.
        const updatedRows = updateResult[0];
        if (updatedRows > 1) {
          throw Error(
            `SqlBlobMetadataStore:updateServiceProperties() failed. Update operation affect ${updatedRows} rows.`
          );
        }
      }

      return serviceProperties;
    });
  }

  public async getServiceProperties(
    context: Context,
    account: string
  ): Promise<ServicePropertiesModel | undefined> {
    const findResult = await ServicesModel.findByPk(account);
    if (findResult === null) {
      return undefined;
    }

    const logging = this.deserializeModelValue(findResult, "logging");
    const hourMetrics = this.deserializeModelValue(findResult, "hourMetrics");
    const minuteMetrics = this.deserializeModelValue(
      findResult,
      "minuteMetrics"
    );
    const cors = this.deserializeModelValue(findResult, "cors");
    const deleteRetentionPolicy = this.deserializeModelValue(
      findResult,
      "deleteRetentionPolicy"
    );
    const staticWebsite = this.deserializeModelValue(
      findResult,
      "staticWebsite"
    );
    const defaultServiceVersion = this.getModelValue<string>(
      findResult,
      "defaultServiceVersion"
    );

    const ret: ServicePropertiesModel = {
      accountName: account
    };

    if (logging !== undefined) {
      ret.logging = logging;
    }
    if (hourMetrics !== undefined) {
      ret.hourMetrics = hourMetrics;
    }
    if (minuteMetrics !== undefined) {
      ret.minuteMetrics = minuteMetrics;
    }
    if (cors !== undefined) {
      ret.cors = cors;
    }
    if (deleteRetentionPolicy !== undefined) {
      ret.deleteRetentionPolicy = deleteRetentionPolicy;
    }
    if (staticWebsite !== undefined) {
      ret.staticWebsite = staticWebsite;
    }
    if (defaultServiceVersion !== undefined) {
      ret.defaultServiceVersion = defaultServiceVersion;
    }

    return ret;
  }

  public async listContainers(
    context: Context,
    account: string,
    prefix: string = "",
    maxResults: number = DEFAULT_LIST_CONTAINERS_MAX_RESULTS,
    marker: number | undefined
  ): Promise<[ContainerModel[], number | undefined]> {
    const whereQuery: any = { accountName: account };

    if (prefix.length > 0) {
      whereQuery.containerName = {
        [Op.like]: `${prefix}%`
      };
    }

    if (marker !== undefined) {
      whereQuery.containerId = {
        [Op.gt]: marker
      };
    }

    const findResult = await ContainersModel.findAll({
      limit: maxResults,
      where: whereQuery as any,
      order: [["containerId", "ASC"]]
    });

    const leaseUpdateMapper = (model: ContainersModel) => {
      const containerModel = this.convertDbModelToContainerModel(model);
      return LeaseFactory.createLeaseState(
        new ContainerLeaseAdapter(containerModel),
        context
      ).sync(new ContainerLeaseSyncer(containerModel));
    };

    if (findResult.length < maxResults) {
      return [findResult.map(leaseUpdateMapper), undefined];
    } else {
      const tail = findResult[findResult.length - 1];
      const nextMarker = this.getModelValue<number>(tail, "containerId", true);
      return [findResult.map(leaseUpdateMapper), nextMarker];
    }
  }

  public async createContainer(
    context: Context,
    container: ContainerModel
  ): Promise<ContainerModel> {
    try {
      await ContainersModel.create(
        this.convertContainerModelToDbModel(container)
      );
      return container;
    } catch (err) {
      if (err.name === "SequelizeUniqueConstraintError") {
        throw StorageErrorFactory.getContainerAlreadyExists(context.contextId);
      }
      throw err;
    }
  }

  public async getContainerProperties(
    context: Context,
    account: string,
    container: string,
    leaseAccessConditions?: Models.LeaseAccessConditions
  ): Promise<GetContainerPropertiesResponse> {
    const findResult = await ContainersModel.findOne({
      where: {
        accountName: account,
        containerName: container
      }
    });

    if (findResult === null || findResult === undefined) {
      throw StorageErrorFactory.getContainerNotFound(context.contextId);
    }

    const containerModel = this.convertDbModelToContainerModel(findResult);

    return LeaseFactory.createLeaseState(
      new ContainerLeaseAdapter(containerModel),
      context
    )
      .validate(new ContainerReadLeaseValidator(leaseAccessConditions))
      .sync(new ContainerLeaseSyncer(containerModel));
  }

  public async deleteContainer(
    context: Context,
    account: string,
    container: string,
    leaseAccessConditions?: Models.LeaseAccessConditions
  ): Promise<void> {
    await this.sequelize.transaction(async t => {
      /* Transaction starts */
      const findResult = await ContainersModel.findOne({
        attributes: ["lease"],
        where: {
          accountName: account,
          containerName: container
        },
        transaction: t
      });

      if (findResult === null || findResult === undefined) {
        throw StorageErrorFactory.getContainerNotFound(context.contextId);
      }

      LeaseFactory.createLeaseState(
        this.convertDbModelToLease(findResult),
        context
      ).validate(new ContainerDeleteLeaseValidator(leaseAccessConditions));

      await ContainersModel.destroy({
        where: {
          accountName: account,
          containerName: container
        },
        transaction: t
      });

      // TODO: GC blobs under deleting status
      await BlobsModel.update(
        {
          deleting: literal("deleting + 1")
        },
        {
          where: {
            accountName: account,
            containerName: container
          },
          transaction: t
        }
      );

      // TODO: GC blocks under deleting status
      await BlocksModel.update(
        {
          deleting: literal("deleting + 1")
        },
        {
          where: {
            accountName: account,
            containerName: container
          },
          transaction: t
        }
      );
      /* Transaction ends */
    });
  }

  public async setContainerMetadata(
    context: Context,
    account: string,
    container: string,
    lastModified: Date,
    etag: string,
    metadata?: IContainerMetadata,
    leaseAccessConditions?: LeaseAccessConditions
  ): Promise<void> {
    return this.sequelize.transaction(async t => {
      /* Transaction starts */
      const findResult = await ContainersModel.findOne({
        attributes: ["lease"],
        where: {
          accountName: account,
          containerName: container
        },
        transaction: t
      });

      if (findResult === null || findResult === undefined) {
        throw StorageErrorFactory.getContainerNotFound(context.contextId);
      }

      LeaseFactory.createLeaseState(
        this.convertDbModelToLease(findResult),
        context
      ).validate(new ContainerReadLeaseValidator(leaseAccessConditions));

      await ContainersModel.update(
        {
          lastModified,
          etag,
          metadata: this.serializeModelValue(metadata) || null
        },
        {
          where: {
            accountName: account,
            containerName: container
          },
          transaction: t
        }
      );
      /* Transaction ends */
    });
  }

  public async getContainerACL(
    context: Context,
    account: string,
    container: string,
    leaseAccessConditions?: Models.LeaseAccessConditions | undefined
  ): Promise<GetContainerAccessPolicyResponse> {
    const findResult = await ContainersModel.findOne({
      where: {
        accountName: account,
        containerName: container
      }
    });

    if (findResult === null || findResult === undefined) {
      throw StorageErrorFactory.getContainerNotFound(context.contextId);
    }

    const containerModel = this.convertDbModelToContainerModel(findResult);

    LeaseFactory.createLeaseState(
      new ContainerLeaseAdapter(containerModel),
      context
    )
      .validate(new ContainerReadLeaseValidator(leaseAccessConditions))
      .sync(new ContainerLeaseSyncer(containerModel));

    return {
      properties: containerModel.properties,
      containerAcl: containerModel.containerAcl
    };
  }

  public async setContainerACL(
    context: Context,
    account: string,
    container: string,
    setAclModel: SetContainerAccessPolicyOptions
  ): Promise<void> {
    await this.sequelize.transaction(async t => {
      const findResult = await ContainersModel.findOne({
        attributes: ["lease"],
        where: {
          accountName: account,
          containerName: container
        },
        transaction: t
      });

      if (findResult === null || findResult === undefined) {
        throw StorageErrorFactory.getContainerNotFound(context.contextId);
      }

      const lease = this.convertDbModelToLease(findResult);

      LeaseFactory.createLeaseState(lease, context).validate(
        new ContainerReadLeaseValidator(setAclModel.leaseAccessConditions)
      );

      const updateResult = await ContainersModel.update(
        {
          lastModified: setAclModel.lastModified,
          etag: setAclModel.etag,
          containerAcl:
            this.serializeModelValue(setAclModel.containerAcl) || null,
          publicAccess: this.serializeModelValue(setAclModel.publicAccess)
        },
        {
          where: {
            accountName: account,
            containerName: container
          },
          transaction: t
        }
      );

      if (updateResult[0] === 0) {
        throw StorageErrorFactory.getContainerNotFound(context.contextId);
      }
    });
  }

  public async acquireContainerLease(
    context: Context,
    account: string,
    container: string,
    options: Models.ContainerAcquireLeaseOptionalParams
  ): Promise<AcquireContainerLeaseResponse> {
    return this.sequelize.transaction(async t => {
      /* Transaction starts */
      const findResult = await ContainersModel.findOne({
        where: {
          accountName: account,
          containerName: container
        },
        transaction: t
      });

      if (findResult === null || findResult === undefined) {
        throw StorageErrorFactory.getContainerNotFound(context.contextId);
      }

      const containerModel = this.convertDbModelToContainerModel(findResult);
      LeaseFactory.createLeaseState(
        new ContainerLeaseAdapter(containerModel),
        context
      )
        .acquire(options.duration!, options.proposedLeaseId)
        .sync(new ContainerLeaseSyncer(containerModel));

      await ContainersModel.update(
        this.convertLeaseToDbModel(new ContainerLeaseAdapter(containerModel)),
        {
          where: {
            accountName: account,
            containerName: container
          },
          transaction: t
        }
      );

      return {
        properties: containerModel.properties,
        leaseId: containerModel.leaseId
      };
      /* Transaction ends */
    });
  }

  public async releaseContainerLease(
    context: Context,
    account: string,
    container: string,
    leaseId: string
  ): Promise<Models.ContainerProperties> {
    return this.sequelize.transaction(async t => {
      /* Transaction starts */
      const findResult = await ContainersModel.findOne({
        where: {
          accountName: account,
          containerName: container
        },
        transaction: t
      });

      if (findResult === null || findResult === undefined) {
        throw StorageErrorFactory.getContainerNotFound(context.contextId);
      }

      const containerModel = this.convertDbModelToContainerModel(findResult);

      LeaseFactory.createLeaseState(
        new ContainerLeaseAdapter(containerModel),
        context
      )
        .release(leaseId)
        .sync(new ContainerLeaseSyncer(containerModel));

      await ContainersModel.update(
        this.convertLeaseToDbModel(new ContainerLeaseAdapter(containerModel)),
        {
          where: {
            accountName: account,
            containerName: container
          },
          transaction: t
        }
      );

      return containerModel.properties;
      /* Transaction ends */
    });
  }

  public async renewContainerLease(
    context: Context,
    account: string,
    container: string,
    leaseId: string
  ): Promise<RenewContainerLeaseResponse> {
    return this.sequelize.transaction(async t => {
      /* Transaction starts */
      // TODO: Filter out unnecessary fields in select query
      const findResult = await ContainersModel.findOne({
        where: {
          accountName: account,
          containerName: container
        },
        transaction: t
      });

      if (findResult === null || findResult === undefined) {
        throw StorageErrorFactory.getContainerNotFound(context.contextId);
      }

      const containerModel = this.convertDbModelToContainerModel(findResult);

      LeaseFactory.createLeaseState(
        new ContainerLeaseAdapter(containerModel),
        context
      )
        .renew(leaseId)
        .sync(new ContainerLeaseSyncer(containerModel));

      await ContainersModel.update(
        this.convertLeaseToDbModel(new ContainerLeaseAdapter(containerModel)),
        {
          where: {
            accountName: account,
            containerName: container
          },
          transaction: t
        }
      );

      return {
        properties: containerModel.properties,
        leaseId: containerModel.leaseId
      };
      /* Transaction ends */
    });
  }

  public async breakContainerLease(
    context: Context,
    account: string,
    container: string,
    breakPeriod: number | undefined
  ): Promise<BreakContainerLeaseResponse> {
    return this.sequelize.transaction(async t => {
      const findResult = await ContainersModel.findOne({
        where: {
          accountName: account,
          containerName: container
        },
        transaction: t
      });

      if (findResult === null || findResult === undefined) {
        throw StorageErrorFactory.getContainerNotFound(context.contextId);
      }

      const containerModel = this.convertDbModelToContainerModel(findResult);

      LeaseFactory.createLeaseState(
        new ContainerLeaseAdapter(containerModel),
        context
      )
        .break(breakPeriod)
        .sync(new ContainerLeaseSyncer(containerModel));

      await ContainersModel.update(
        this.convertLeaseToDbModel(new ContainerLeaseAdapter(containerModel)),
        {
          where: {
            accountName: account,
            containerName: container
          },
          transaction: t
        }
      );

      const leaseTimeSeconds: number =
        containerModel.properties.leaseState ===
          Models.LeaseStateType.Breaking && containerModel.leaseBreakTime
          ? Math.round(
              (containerModel.leaseBreakTime.getTime() -
                context.startTime!.getTime()) /
                1000
            )
          : 0;

      return {
        properties: containerModel.properties,
        leaseTime: leaseTimeSeconds
      };
    });
  }

  public async changeContainerLease(
    context: Context,
    account: string,
    container: string,
    leaseId: string,
    proposedLeaseId: string
  ): Promise<ChangeContainerLeaseResponse> {
    return this.sequelize.transaction(async t => {
      const findResult = await ContainersModel.findOne({
        where: {
          accountName: account,
          containerName: container
        },
        transaction: t
      });

      if (findResult === null || findResult === undefined) {
        throw StorageErrorFactory.getContainerNotFound(context.contextId);
      }

      const containerModel = this.convertDbModelToContainerModel(findResult);

      LeaseFactory.createLeaseState(
        new ContainerLeaseAdapter(containerModel),
        context
      )
        .change(leaseId, proposedLeaseId)
        .sync(new ContainerLeaseSyncer(containerModel));

      await ContainersModel.update(
        this.convertLeaseToDbModel(new ContainerLeaseAdapter(containerModel)),
        {
          where: {
            accountName: account,
            containerName: container
          },
          transaction: t
        }
      );

      return {
        properties: containerModel.properties,
        leaseId: containerModel.leaseId
      };
    });
  }

  public async checkContainerExist(
    context: Context,
    account: string,
    container: string
  ): Promise<void> {
    const res = await ContainersModel.findOne({
      where: {
        accountName: account,
        containerName: container
      }
    });
    if (res === undefined || res === null) {
      throw StorageErrorFactory.getContainerNotFound(context.contextId);
    }
  }

  public async createBlob(
    context: Context,
    blob: BlobModel,
    leaseAccessConditions?: Models.LeaseAccessConditions
  ): Promise<void> {
    return this.sequelize.transaction(async t => {
      const containerFindResult = await ContainersModel.findOne({
        where: {
          accountName: blob.accountName,
          containerName: blob.containerName
        },
        transaction: t
      });

      if (containerFindResult === null || containerFindResult === undefined) {
        throw StorageErrorFactory.getContainerNotFound(context.contextId);
      }

      const blobFindResult = await BlobsModel.findOne({
        where: {
          accountName: blob.accountName,
          containerName: blob.containerName,
          blobName: blob.name,
          snapshot: blob.snapshot,
          deleting: 0,
          isCommitted: true
        },
        transaction: t
      });

      if (blobFindResult) {
        const blobModel: BlobModel = this.convertDbModelToBlobModel(
          blobFindResult
        );

        LeaseFactory.createLeaseState(
          new BlobLeaseAdapter(blobModel),
          context
        ).validate(new BlobWriteLeaseValidator(leaseAccessConditions));

        if (
          blobModel.properties !== undefined &&
          blobModel.properties.accessTier === Models.AccessTier.Archive
        ) {
          throw StorageErrorFactory.getBlobArchived(context.contextId);
        }
      }

      await BlobsModel.upsert(this.convertBlobModelToDbModel(blob), {
        transaction: t
      });
    });
  }

  public async downloadBlob(
    context: Context,
    account: string,
    container: string,
    blob: string,
    snapshot: string = "",
    leaseAccessConditions?: Models.LeaseAccessConditions
  ): Promise<BlobModel> {
    return this.sequelize.transaction(async t => {
      const containerFindResult = await ContainersModel.findOne({
        where: {
          accountName: account,
          containerName: container
        },
        transaction: t
      });

      if (containerFindResult === null || containerFindResult === undefined) {
        throw StorageErrorFactory.getContainerNotFound(context.contextId);
      }

      const blobFindResult = await BlobsModel.findOne({
        where: {
          accountName: account,
          containerName: container,
          blobName: blob,
          snapshot,
          deleting: 0,
          isCommitted: true
        },
        transaction: t
      });

      if (blobFindResult === null || blobFindResult === undefined) {
        throw StorageErrorFactory.getBlobNotFound(context.contextId);
      }

      const blobModel: BlobModel = this.convertDbModelToBlobModel(
        blobFindResult
      );

      return LeaseFactory.createLeaseState(
        new BlobLeaseAdapter(blobModel),
        context
      )
        .validate(new BlobReadLeaseValidator(leaseAccessConditions))
        .sync(new BlobLeaseSyncer(blobModel));
    });
  }

  // TODO: Filter uncommitted blobs
  public async listBlobs(
    context: Context,
    account: string,
    container: string,
    blob?: string,
    prefix: string = "",
    maxResults: number = DEFAULT_LIST_BLOBS_MAX_RESULTS,
    marker?: string,
    includeSnapshots?: boolean
  ): Promise<[BlobModel[], any | undefined]> {
    return this.sequelize.transaction(async t => {
      const containerFindResult = await ContainersModel.findOne({
        where: {
          accountName: account,
          containerName: container
        },
        transaction: t
      });

      if (containerFindResult === null || containerFindResult === undefined) {
        throw StorageErrorFactory.getContainerNotFound(context.contextId);
      }

      const whereQuery: any = {
        accountName: account,
        containerName: container
      };
      if (blob !== undefined) {
        whereQuery.blobName = blob;
      }
      if (prefix.length > 0) {
        whereQuery.blobName = {
          [Op.like]: `${prefix}%`
        };
      }
      if (marker !== undefined) {
        whereQuery.blobName = {
          [Op.gt]: marker
        };
      }
      if (!includeSnapshots) {
        whereQuery.snapshot = "";
      }
      whereQuery.deleting = 0;

      const blobFindResult = await BlobsModel.findAll({
        limit: maxResults + 1,
        where: whereQuery as any,
        order: [["blobName", "ASC"]],
        transaction: t
      });

      const leaseUpdateMapper = (model: BlobsModel) => {
        const blobModel = this.convertDbModelToBlobModel(model);
        return LeaseFactory.createLeaseState(
          new BlobLeaseAdapter(blobModel),
          context
        ).sync(new BlobLeaseSyncer(blobModel));
      };

      if (blobFindResult.length <= maxResults) {
        return [blobFindResult.map(leaseUpdateMapper), undefined];
      } else {
        blobFindResult.pop();
        const tail = blobFindResult[blobFindResult.length - 1];
        const nextMarker = this.getModelValue<string>(tail, "blobName", true);
        return [blobFindResult.map(leaseUpdateMapper), nextMarker];
      }
    });
  }

  public async listAllBlobs(
    maxResults: number = DEFAULT_LIST_BLOBS_MAX_RESULTS,
    marker?: string,
    includeSnapshots?: boolean
  ): Promise<[BlobModel[], any | undefined]> {
    const whereQuery: any = {};
    if (marker !== undefined) {
      whereQuery.blobName = {
        [Op.gt]: marker
      };
    }
    if (!includeSnapshots) {
      whereQuery.snapshot = "";
    }
    whereQuery.deleting = 0;

    const blobFindResult = await BlobsModel.findAll({
      limit: maxResults + 1,
      where: whereQuery as any,
      order: [["blobName", "ASC"]]
    });

    if (blobFindResult.length <= maxResults) {
      return [
        blobFindResult.map(this.convertDbModelToBlobModel.bind(this)),
        undefined
      ];
    } else {
      blobFindResult.pop();
      const tail = blobFindResult[blobFindResult.length - 1];
      const nextMarker = this.getModelValue<string>(tail, "blobName", true);
      return [
        blobFindResult.map(this.convertDbModelToBlobModel.bind(this)),
        nextMarker
      ];
    }
  }

  public async stageBlock(context: Context, block: BlockModel): Promise<void> {
    await BlocksModel.upsert({
      accountName: block.accountName,
      containerName: block.containerName,
      blobName: block.blobName,
      blockName: block.name,
      size: block.size,
      persistency: this.serializeModelValue(block.persistency)
    });
  }

  public async getBlockList(
    context: Context,
    account: string,
    container: string,
    blob: string,
    isCommitted?: boolean,
    leaseAccessConditions?: Models.LeaseAccessConditions
  ): Promise<any> {
    const res: {
      uncommittedBlocks: Models.Block[];
      committedBlocks: Models.Block[];
    } = {
      uncommittedBlocks: [],
      committedBlocks: []
    };

    await this.sequelize.transaction(async t => {
      if (isCommitted !== false) {
        const blobFindResult = await BlobsModel.findOne({
          where: {
            accountName: account,
            containerName: container,
            blobName: blob,
            snapshot: "",
            deleting: 0,
            isCommitted: true
          },
          transaction: t
        });

        if (blobFindResult !== null && blobFindResult !== undefined) {
          const blobModel = this.convertDbModelToBlobModel(blobFindResult);

          LeaseFactory.createLeaseState(
            new BlobLeaseAdapter(blobModel),
            context
          ).validate(new BlobReadLeaseValidator(leaseAccessConditions));

          res.committedBlocks = blobModel.committedBlocksInOrder || [];
        }
      }

      if (isCommitted !== true) {
        const blocks = await BlocksModel.findAll({
          attributes: ["blockName", "size"],
          where: {
            accountName: account,
            containerName: container,
            blobName: blob,
            deleting: 0
          },
          order: [["id", "ASC"]],
          transaction: t
        });
        for (const item of blocks) {
          const block = {
            name: this.getModelValue<string>(item, "blockName", true),
            size: this.getModelValue<number>(item, "size", true)
          };
          res.uncommittedBlocks.push(block);
        }
      }
    });

    return res;
  }

  public async commitBlockList(
    context: Context,
    blob: BlobModel,
    blockList: { blockName: string; blockCommitType: string }[],
    leaseAccessConditions: Models.LeaseAccessConditions | undefined
  ): Promise<void> {
    await this.sequelize.transaction(async t => {
      const containerFindResult = await ContainersModel.findOne({
        where: {
          accountName: blob.accountName,
          containerName: blob.containerName
        },
        transaction: t
      });

      if (containerFindResult === null || containerFindResult === undefined) {
        throw StorageErrorFactory.getContainerNotFound(context.contextId);
      }

      const pCommittedBlocksMap: Map<string, PersistencyBlockModel> = new Map(); // persistencyCommittedBlocksMap
      const pUncommittedBlocksMap: Map<
        string,
        PersistencyBlockModel
      > = new Map(); // persistencyUncommittedBlocksMap

      const badRequestError = StorageErrorFactory.getInvalidOperation(
        context.contextId
      );

      const blobFindResult = await BlobsModel.findOne({
        where: {
          accountName: blob.accountName,
          containerName: blob.containerName,
          blobName: blob.name,
          snapshot: blob.snapshot,
          deleting: 0
        },
        transaction: t
      });

      if (blobFindResult !== null && blobFindResult !== undefined) {
        const blobModel: BlobModel = this.convertDbModelToBlobModel(
          blobFindResult
        );

        LeaseFactory.createLeaseState(
          new BlobLeaseAdapter(blobModel),
          context
        ).validate(new BlobWriteLeaseValidator(leaseAccessConditions));

        const committedBlocksInOrder = blobModel.committedBlocksInOrder;
        for (const pBlock of committedBlocksInOrder || []) {
          pCommittedBlocksMap.set(pBlock.name, pBlock);
        }
      }

      const blockFindResult = await BlocksModel.findAll({
        where: {
          accountName: blob.accountName,
          containerName: blob.containerName,
          blobName: blob.name,
          deleting: 0
        },
        transaction: t
      });
      for (const item of blockFindResult) {
        const block = {
          name: this.getModelValue<string>(item, "blockName", true),
          size: this.getModelValue<number>(item, "size", true),
          persistency: this.deserializeModelValue(item, "persistency")
        };
        pUncommittedBlocksMap.set(block.name, block);
      }
      const selectedBlockList: PersistencyBlockModel[] = [];
      for (const block of blockList) {
        switch (block.blockCommitType.toLowerCase()) {
          case "uncommitted":
            const pUncommittedBlock = pUncommittedBlocksMap.get(
              block.blockName
            );
            if (pUncommittedBlock === undefined) {
              throw badRequestError;
            } else {
              selectedBlockList.push(pUncommittedBlock);
            }
            break;
          case "committed":
            const pCommittedBlock = pCommittedBlocksMap.get(block.blockName);
            if (pCommittedBlock === undefined) {
              throw badRequestError;
            } else {
              selectedBlockList.push(pCommittedBlock);
            }
            break;
          case "latest":
            const pLatestBlock =
              pUncommittedBlocksMap.get(block.blockName) ||
              pCommittedBlocksMap.get(block.blockName);
            if (pLatestBlock === undefined) {
              throw badRequestError;
            } else {
              selectedBlockList.push(pLatestBlock);
            }
            break;
          default:
            throw badRequestError;
        }
      }

      const commitBlockBlob: BlobModel = {
        ...blob,
        deleted: false,
        committedBlocksInOrder: selectedBlockList,
        properties: {
          ...blob.properties,
          creationTime: blob.properties.creationTime || context.startTime,
          lastModified: blob.properties.lastModified || context.startTime,
          contentLength: selectedBlockList
            .map(block => block.size)
            .reduce((total, val) => {
              return total + val;
            }),
          blobType: BlobType.BlockBlob
        }
      };

      await BlobsModel.upsert(this.convertBlobModelToDbModel(commitBlockBlob), {
        transaction: t
      });

      await BlocksModel.update(
        {
          deleting: literal("deleting + 1")
        },
        {
          where: {
            accountName: blob.accountName,
            containerName: blob.containerName,
            blobName: blob.name
          },
          transaction: t
        }
      );
    });
  }

  public async getBlobProperties(
    context: Context,
    account: string,
    container: string,
    blob: string,
    snapshot: string = "",
    leaseAccessConditions?: Models.LeaseAccessConditions
  ): Promise<GetBlobPropertiesRes> {
    return this.sequelize.transaction(async t => {
      const containerFindResult = await ContainersModel.findOne({
        where: {
          accountName: account,
          containerName: container
        },
        transaction: t
      });

      if (containerFindResult === null || containerFindResult === undefined) {
        throw StorageErrorFactory.getContainerNotFound(context.contextId);
      }

      const blobFindResult = await BlobsModel.findOne({
        where: {
          accountName: account,
          containerName: container,
          blobName: blob,
          snapshot,
          deleting: 0,
          isCommitted: true
        },
        transaction: t
      });

      if (blobFindResult === null || blobFindResult === undefined) {
        throw StorageErrorFactory.getBlobNotFound(context.contextId);
      }

      const blobModel: BlobModel = this.convertDbModelToBlobModel(
        blobFindResult
      );

      return LeaseFactory.createLeaseState(
        new BlobLeaseAdapter(blobModel),
        context
      )
        .validate(new BlobReadLeaseValidator(leaseAccessConditions))
        .sync(new BlobLeaseSyncer(blobModel));
    });
  }

  public undeleteBlob(): Promise<void> {
    throw new Error("Method not implemented.");
  }

  public async createSnapshot(
    context: Context,
    account: string,
    container: string,
    blob: string,
    leaseAccessConditions?: Models.LeaseAccessConditions,
    metadata?: Models.BlobMetadata
  ): Promise<CreateSnapshotResponse> {
    return this.sequelize.transaction(async t => {
      const containerFindResult = await ContainersModel.findOne({
        attributes: ["accountName"], // TODO: Optimize select attributes for all queries
        where: {
          accountName: account,
          containerName: container
        },
        transaction: t
      });

      if (containerFindResult === null || containerFindResult === undefined) {
        throw StorageErrorFactory.getContainerNotFound(context.contextId);
      }

      const blobFindResult = await BlobsModel.findOne({
        where: {
          accountName: account,
          containerName: container,
          blobName: blob,
          snapshot: "",
          deleting: 0,
          isCommitted: true
        },
        transaction: t
      });

      if (blobFindResult === null || blobFindResult === undefined) {
        throw StorageErrorFactory.getBlobNotFound(context.contextId);
      }

      const snapshotBlob: BlobModel = this.convertDbModelToBlobModel(
        blobFindResult
      );

      LeaseFactory.createLeaseState(
        new BlobLeaseAdapter(snapshotBlob),
        context
      ).validate(new BlobReadLeaseValidator(leaseAccessConditions));

      snapshotBlob.snapshot = context.startTime!.toISOString();
      snapshotBlob.metadata = metadata || snapshotBlob.metadata;

      new BlobLeaseSyncer(snapshotBlob).sync({
        leaseId: undefined,
        leaseExpireTime: undefined,
        leaseDurationSeconds: undefined,
        leaseBreakTime: undefined,
        leaseDurationType: undefined,
        leaseState: undefined,
        leaseStatus: undefined
      });

      await BlobsModel.upsert(this.convertBlobModelToDbModel(snapshotBlob), {
        transaction: t
      });

      return {
        properties: snapshotBlob.properties,
        snapshot: snapshotBlob.snapshot
      };
    });
  }

  public async deleteBlob(
    context: Context,
    account: string,
    container: string,
    blob: string,
    options: Models.BlobDeleteMethodOptionalParams
  ): Promise<void> {
    await this.sequelize.transaction(async t => {
      const containerRes = await ContainersModel.findOne({
        attributes: ["accountName"],
        where: {
          accountName: account,
          containerName: container
        },
        transaction: t
      });

      const requestId = context ? context.contextId : undefined;
      if (containerRes === null || containerRes === undefined) {
        throw StorageErrorFactory.getContainerNotFound(requestId);
      }

      const res = await BlobsModel.findOne({
        attributes: [
          "leaseId",
          "leaseStatus",
          "leaseDuration",
          "leaseState",
          "leasedurationNumber",
          "leaseExpireTime",
          "leaseBreakExpireTime",
          "snapshot"
        ],
        where: {
          accountName: account,
          containerName: container,
          blobName: blob,
          snapshot: options.snapshot === undefined ? "" : options.snapshot,
          deleting: 0
        },
        transaction: t
      });

      if (res === null || res === undefined) {
        throw StorageErrorFactory.getBlobNotFound(requestId);
      }

      const lease = this.getBlobLease(res, context);

      const snapshot = this.getModelValue<string>(res, "snapshot", true);
      const againstBaseBlob = snapshot === "";
      if (againstBaseBlob) {
        this.checkBlobLeaseOnWriteBlob(
          lease.leaseId,
          lease.leaseStatus,
          options.leaseAccessConditions,
          requestId
        );
      }

      // Check bad requests
      if (!againstBaseBlob && options.deleteSnapshots !== undefined) {
        throw StorageErrorFactory.getInvalidOperation(
          context.contextId!,
          "Invalid operation against a blob snapshot."
        );
      }

      // Scenario: Delete base blob only
      if (againstBaseBlob && options.deleteSnapshots === undefined) {
        const count = await BlobsModel.count({
          where: {
            accountName: account,
            containerName: container,
            blobName: blob,
            deleting: 0
          },
          transaction: t
        });
        if (count > 1) {
          throw StorageErrorFactory.getSnapshotsPresent(context.contextId!);
        } else {
          await BlobsModel.update(
            {
              deleting: literal("deleting + 1")
            },
            {
              where: {
                accountName: account,
                containerName: container,
                blobName: blob
              },
              transaction: t
            }
          );

          await BlocksModel.update(
            {
              deleting: literal("deleting + 1")
            },
            {
              where: {
                accountName: account,
                containerName: container,
                blobName: blob
              },
              transaction: t
            }
          );
        }
      }

      // Scenario: Delete one snapshot only
      if (!againstBaseBlob) {
        await BlobsModel.update(
          {
            deleting: literal("deleting + 1")
          },
          {
            where: {
              accountName: account,
              containerName: container,
              blobName: blob,
              snapshot
            },
            transaction: t
          }
        );
      }

      // Scenario: Delete base blob and snapshots
      if (
        againstBaseBlob &&
        options.deleteSnapshots === Models.DeleteSnapshotsOptionType.Include
      ) {
        await BlobsModel.update(
          {
            deleting: literal("deleting + 1")
          },
          {
            where: {
              accountName: account,
              containerName: container,
              blobName: blob
            },
            transaction: t
          }
        );

        await BlocksModel.update(
          {
            deleting: literal("deleting + 1")
          },
          {
            where: {
              accountName: account,
              containerName: container,
              blobName: blob
            },
            transaction: t
          }
        );
      }

      // Scenario: Delete all snapshots only
      if (
        againstBaseBlob &&
        options.deleteSnapshots === Models.DeleteSnapshotsOptionType.Only
      ) {
        await BlobsModel.update(
          {
            deleting: literal("deleting + 1")
          },
          {
            where: {
              accountName: account,
              containerName: container,
              blobName: blob,
              snapshot: { [Op.gt]: "" }
            },
            transaction: t
          }
        );
      }
    });
  }

  public async setBlobHTTPHeaders(
    context: Context,
    account: string,
    container: string,
    blob: string,
    leaseAccessConditions: Models.LeaseAccessConditions | undefined,
    blobHTTPHeaders: Models.BlobHTTPHeaders | undefined
  ): Promise<Models.BlobProperties> {
    return this.sequelize.transaction(async t => {
      const containerFindResult = await ContainersModel.findOne({
        attributes: ["accountName"],
        where: {
          accountName: account,
          containerName: container
        },
        transaction: t
      });

      if (containerFindResult === null || containerFindResult === undefined) {
        throw StorageErrorFactory.getContainerNotFound(context.contextId);
      }

      const blobFindResult = await BlobsModel.findOne({
        where: {
          accountName: account,
          containerName: container,
          blobName: blob,
          snapshot: "",
          deleting: 0,
          isCommitted: true
        },
        transaction: t
      });

      if (blobFindResult === null || blobFindResult === undefined) {
        throw StorageErrorFactory.getBlobNotFound(context.contextId);
      }

      const blobModel: BlobModel = this.convertDbModelToBlobModel(
        blobFindResult
      );

      LeaseFactory.createLeaseState(new BlobLeaseAdapter(blobModel), context)
        .validate(new BlobWriteLeaseValidator(leaseAccessConditions))
        .sync(new BlobWriteLeaseSyncer(blobModel));

      if (blobHTTPHeaders !== undefined) {
        blobModel.properties.cacheControl = blobHTTPHeaders.blobCacheControl;
        blobModel.properties.contentType = blobHTTPHeaders.blobContentType;
        blobModel.properties.contentMD5 = blobHTTPHeaders.blobContentMD5;
        blobModel.properties.contentEncoding =
          blobHTTPHeaders.blobContentEncoding;
        blobModel.properties.contentLanguage =
          blobHTTPHeaders.blobContentLanguage;
        blobModel.properties.contentDisposition =
          blobHTTPHeaders.blobContentDisposition;
        blobModel.properties.lastModified = context.startTime
          ? context.startTime
          : new Date();
      }

      const contentProperties =
        this.serializeModelValue({
          contentLength: blobModel.properties.contentLength,
          contentType: blobModel.properties.contentType,
          contentEncoding: blobModel.properties.contentEncoding,
          contentLanguage: blobModel.properties.contentLanguage,
          contentMD5: blobModel.properties.contentMD5,
          contentDisposition: blobModel.properties.contentDisposition,
          cacheControl: blobModel.properties.cacheControl
        }) || null;

      await BlobsModel.update(
        {
          etag: uuid(),
          lastModified: blobModel.properties.lastModified,
          contentProperties,
          leaseStatus: blobModel.properties.leaseStatus
            ? blobModel.properties.leaseStatus
            : null,
          leaseState: blobModel.properties.leaseState
            ? blobModel.properties.leaseState
            : null,
          leaseDuration: blobModel.properties.leaseDuration
            ? blobModel.properties.leaseDuration
            : null,
          leaseId: blobModel.leaseId ? blobModel.leaseId : null,
          leasedurationNumber: blobModel.leaseDurationSeconds
            ? blobModel.leaseDurationSeconds
            : null,
          leaseExpireTime: blobModel.leaseExpireTime
            ? blobModel.leaseExpireTime
            : null,
          leaseBreakExpireTime: blobModel.leaseBreakTime
            ? blobModel.leaseBreakTime
            : null
        },
        {
          where: {
            accountName: account,
            containerName: container,
            blobName: blob,
            snapshot: "",
            deleting: 0
          },
          transaction: t
        }
      );

      return blobModel.properties;
    });
  }

  public setBlobMetadata(
    context: Context,
    account: string,
    container: string,
    blob: string,
    leaseAccessConditions: Models.LeaseAccessConditions | undefined,
    metadata: Models.BlobMetadata | undefined
  ): Promise<Models.BlobProperties> {
    return this.sequelize.transaction(async t => {
      const containerRes = await ContainersModel.findOne({
        attributes: ["accountName"],
        where: {
          accountName: account,
          containerName: container
        },
        transaction: t
      });

      const requestId = context ? context.contextId : undefined;
      if (containerRes === null || containerRes === undefined) {
        throw StorageErrorFactory.getContainerNotFound(requestId);
      }

      const res = await BlobsModel.findOne({
        where: {
          accountName: account,
          containerName: container,
          blobName: blob,
          snapshot: "",
          deleting: 0
        },
        transaction: t
      });

      if (res === null || res === undefined) {
        throw StorageErrorFactory.getBlobNotFound(requestId);
      }

      let lease = this.getBlobLease(res, context);

      // Check Lease status
      this.checkBlobLeaseOnWriteBlob(
        lease.leaseId,
        lease.leaseStatus,
        leaseAccessConditions,
        requestId
      );

      lease = this.UpdateBlobLeaseStateOnWriteBlob(lease);

      const etag = this.getModelValue<string>(res, "etag", true);
      const lastModified = this.getModelValue<Date>(res, "lastModified", true);

      await BlobsModel.update(
        {
          metadata: this.serializeModelValue(metadata) || null,
          lastModified,
          leaseStatus: lease.leaseStatus ? lease.leaseStatus : null,
          leaseState: lease.leaseState ? lease.leaseState : null,
          leaseDuration: lease.leaseDurationType
            ? lease.leaseDurationType
            : null,
          leaseId: lease.leaseId ? lease.leaseId : null,
          leasedurationNumber: lease.leaseDurationSeconds
            ? lease.leaseDurationSeconds
            : null,
          leaseExpireTime: lease.leaseExpireTime ? lease.leaseExpireTime : null,
          leaseBreakExpireTime: lease.leaseBreakTime
            ? lease.leaseBreakTime
            : null
        },
        {
          where: {
            accountName: account,
            containerName: container,
            blobName: blob,
            snapshot: "",
            deleting: 0
          },
          transaction: t
        }
      );

      const ret: Models.BlobProperties = {
        lastModified,
        etag,
        leaseStatus: lease.leaseStatus,
        leaseDuration: lease.leaseDurationType,
        leaseState: lease.leaseState
      };

      return ret;
    });
  }

  public async acquireBlobLease(
    context: Context,
    account: string,
    container: string,
    blob: string,
    duration: number,
    proposedLeaseId?: string
  ): Promise<AcquireBlobLeaseResponse> {
    return this.sequelize.transaction(async t => {
      const containerRes = await ContainersModel.findOne({
        attributes: ["accountName"],
        where: {
          accountName: account,
          containerName: container
        },
        transaction: t
      });

      const requestId = context ? context.contextId : undefined;
      if (containerRes === null || containerRes === undefined) {
        throw StorageErrorFactory.getContainerNotFound(requestId);
      }

      const res = await BlobsModel.findOne({
        where: {
          accountName: account,
          containerName: container,
          blobName: blob,
          snapshot: "",
          deleting: 0
        },
        transaction: t
      });

      if (res === null || res === undefined) {
        throw StorageErrorFactory.getBlobNotFound(requestId);
      }

      const lease = this.getBlobLease(res, context);
      // check the lease action aligned with current lease state.
      const snapshot = this.getModelValue<string>(res, "snapshot", true);
      if (snapshot !== "") {
        throw StorageErrorFactory.getBlobSnapshotsPresent(context.contextId!);
      }
      if (lease.leaseState === Models.LeaseStateType.Breaking) {
        throw StorageErrorFactory.getLeaseAlreadyPresent(context.contextId!);
      }
      if (
        lease.leaseState === Models.LeaseStateType.Leased &&
        proposedLeaseId !== lease.leaseId
      ) {
        throw StorageErrorFactory.getLeaseAlreadyPresent(context.contextId!);
      }

      // update the lease information
      if (duration === -1 || duration === undefined) {
        lease.leaseDurationType = Models.LeaseDurationType.Infinite;
      } else {
        // verify duration between 15 and 60
        if (duration > 60 || duration < 15) {
          throw StorageErrorFactory.getInvalidLeaseDuration(context.contextId!);
        }
        lease.leaseDurationType = Models.LeaseDurationType.Fixed;
        lease.leaseExpireTime = context.startTime!;
        lease.leaseExpireTime.setSeconds(
          lease.leaseExpireTime.getSeconds() + duration
        );
        lease.leaseDurationSeconds = duration;
      }
      lease.leaseState = Models.LeaseStateType.Leased;
      lease.leaseStatus = Models.LeaseStatusType.Locked;
      lease.leaseId =
        proposedLeaseId !== "" && proposedLeaseId !== undefined
          ? proposedLeaseId
          : uuid();
      lease.leaseBreakTime = undefined;

      const properties: Models.BlobProperties = {
        etag: this.getModelValue<string>(res, "etag", true),
        lastModified: this.getModelValue<Date>(res, "lastModified", true)
      };

      await BlobsModel.update(
        {
          leaseStatus: lease.leaseStatus ? lease.leaseStatus : null,
          leaseState: lease.leaseState ? lease.leaseState : null,
          leaseDuration: lease.leaseDurationType
            ? lease.leaseDurationType
            : null,
          leaseId: lease.leaseId ? lease.leaseId : null,
          leasedurationNumber: lease.leaseDurationSeconds
            ? lease.leaseDurationSeconds
            : null,
          leaseExpireTime: lease.leaseExpireTime ? lease.leaseExpireTime : null,
          leaseBreakExpireTime: lease.leaseBreakTime
            ? lease.leaseBreakTime
            : null
        },
        {
          where: {
            accountName: account,
            containerName: container,
            blobName: blob,
            snapshot: "",
            deleting: 0
          },
          transaction: t
        }
      );
      return { properties, leaseId: lease.leaseId };
    });
  }

  public async releaseBlobLease(
    context: Context,
    account: string,
    container: string,
    blob: string,
    leaseId: string
  ): Promise<ReleaseBlobLeaseResponse> {
    return this.sequelize.transaction(async t => {
      const containerRes = await ContainersModel.findOne({
        attributes: ["accountName"],
        where: {
          accountName: account,
          containerName: container
        },
        transaction: t
      });

      const requestId = context ? context.contextId : undefined;
      if (containerRes === null || containerRes === undefined) {
        throw StorageErrorFactory.getContainerNotFound(requestId);
      }

      const res = await BlobsModel.findOne({
        where: {
          accountName: account,
          containerName: container,
          blobName: blob,
          snapshot: "",
          deleting: 0
        },
        transaction: t
      });

      if (res === null || res === undefined) {
        throw StorageErrorFactory.getBlobNotFound(requestId);
      }

      const lease = this.getBlobLease(res, context);

      const snapshot = this.getModelValue<string>(res, "snapshot", true);
      // check the lease action aligned with current lease state.
      if (snapshot !== "") {
        throw StorageErrorFactory.getBlobSnapshotsPresent(context.contextId!);
      }
      if (lease.leaseState === Models.LeaseStateType.Available) {
        throw StorageErrorFactory.getBlobLeaseIdMismatchWithLeaseOperation(
          context.contextId!
        );
      }

      // Check lease ID
      if (lease.leaseId !== leaseId) {
        throw StorageErrorFactory.getBlobLeaseIdMismatchWithLeaseOperation(
          context.contextId!
        );
      }

      // update the lease information
      lease.leaseState = Models.LeaseStateType.Available;
      lease.leaseStatus = Models.LeaseStatusType.Unlocked;
      lease.leaseDurationType = undefined;
      lease.leaseDurationSeconds = undefined;
      lease.leaseId = undefined;
      lease.leaseExpireTime = undefined;
      lease.leaseBreakTime = undefined;

      const properties: Models.BlobProperties = {
        etag: this.getModelValue<string>(res, "etag", true),
        lastModified: this.getModelValue<Date>(res, "lastModified", true)
      };

      await BlobsModel.update(
        {
          leaseStatus: lease.leaseStatus ? lease.leaseStatus : null,
          leaseState: lease.leaseState ? lease.leaseState : null,
          leaseDuration: lease.leaseDurationType
            ? lease.leaseDurationType
            : null,
          leaseId: lease.leaseId ? lease.leaseId : null,
          leasedurationNumber: lease.leaseDurationSeconds
            ? lease.leaseDurationSeconds
            : null,
          leaseExpireTime: lease.leaseExpireTime ? lease.leaseExpireTime : null,
          leaseBreakExpireTime: lease.leaseBreakTime
            ? lease.leaseBreakTime
            : null
        },
        {
          where: {
            accountName: account,
            containerName: container,
            blobName: blob,
            snapshot: "",
            deleting: 0
          },
          transaction: t
        }
      );
      return properties;
    });
  }

  public async renewBlobLease(
    context: Context,
    account: string,
    container: string,
    blob: string,
    leaseId: string
  ): Promise<RenewBlobLeaseResponse> {
    return this.sequelize.transaction(async t => {
      const containerRes = await ContainersModel.findOne({
        attributes: ["accountName"],
        where: {
          accountName: account,
          containerName: container
        },
        transaction: t
      });

      const requestId = context ? context.contextId : undefined;
      if (containerRes === null || containerRes === undefined) {
        throw StorageErrorFactory.getContainerNotFound(requestId);
      }

      const res = await BlobsModel.findOne({
        where: {
          accountName: account,
          containerName: container,
          blobName: blob,
          snapshot: "",
          deleting: 0
        },
        transaction: t
      });

      if (res === null || res === undefined) {
        throw StorageErrorFactory.getBlobNotFound(requestId);
      }

      const lease = this.getBlobLease(res, context);

      const snapshot = this.getModelValue<string>(res, "snapshot", true);
      // check the lease action aligned with current lease state.
      if (snapshot !== "") {
        throw StorageErrorFactory.getBlobSnapshotsPresent(context.contextId!);
      }
      if (lease.leaseState === Models.LeaseStateType.Available) {
        throw StorageErrorFactory.getBlobLeaseIdMismatchWithLeaseOperation(
          context.contextId!
        );
      }
      if (
        lease.leaseState === Models.LeaseStateType.Breaking ||
        lease.leaseState === Models.LeaseStateType.Broken
      ) {
        throw StorageErrorFactory.getLeaseIsBrokenAndCannotBeRenewed(
          context.contextId!
        );
      }

      // Check lease ID
      if (lease.leaseId !== leaseId) {
        throw StorageErrorFactory.getBlobLeaseIdMismatchWithLeaseOperation(
          context.contextId!
        );
      }

      // update the lease information
      lease.leaseState = Models.LeaseStateType.Leased;
      lease.leaseStatus = Models.LeaseStatusType.Locked;
      // when container.leaseduration has value (not -1), means fixed duration
      if (
        lease.leaseDurationSeconds !== undefined &&
        lease.leaseDurationSeconds !== -1
      ) {
        lease.leaseExpireTime = context.startTime!;
        lease.leaseExpireTime.setSeconds(
          lease.leaseExpireTime.getSeconds() + lease.leaseDurationSeconds
        );
        lease.leaseDurationType = Models.LeaseDurationType.Fixed;
      } else {
        lease.leaseDurationType = Models.LeaseDurationType.Infinite;
      }

      const properties: Models.BlobProperties = {
        etag: this.getModelValue<string>(res, "etag", true),
        lastModified: this.getModelValue<Date>(res, "lastModified", true)
      };

      await BlobsModel.update(
        {
          leaseStatus: lease.leaseStatus ? lease.leaseStatus : null,
          leaseState: lease.leaseState ? lease.leaseState : null,
          leaseDuration: lease.leaseDurationType
            ? lease.leaseDurationType
            : null,
          leaseId: lease.leaseId ? lease.leaseId : null,
          leasedurationNumber: lease.leaseDurationSeconds
            ? lease.leaseDurationSeconds
            : null,
          leaseExpireTime: lease.leaseExpireTime ? lease.leaseExpireTime : null,
          leaseBreakExpireTime: lease.leaseBreakTime
            ? lease.leaseBreakTime
            : null
        },
        {
          where: {
            accountName: account,
            containerName: container,
            blobName: blob,
            snapshot: "",
            deleting: 0
          },
          transaction: t
        }
      );
      return { properties, leaseId: lease.leaseId };
    });
  }

  public async changeBlobLease(
    context: Context,
    account: string,
    container: string,
    blob: string,
    leaseId: string,
    proposedLeaseId: string
  ): Promise<ChangeBlobLeaseResponse> {
    return this.sequelize.transaction(async t => {
      const containerRes = await ContainersModel.findOne({
        attributes: ["accountName"],
        where: {
          accountName: account,
          containerName: container
        },
        transaction: t
      });

      const requestId = context ? context.contextId : undefined;
      if (containerRes === null || containerRes === undefined) {
        throw StorageErrorFactory.getContainerNotFound(requestId);
      }

      const res = await BlobsModel.findOne({
        where: {
          accountName: account,
          containerName: container,
          blobName: blob,
          snapshot: "",
          deleting: 0
        },
        transaction: t
      });

      if (res === null || res === undefined) {
        throw StorageErrorFactory.getBlobNotFound(requestId);
      }

      const lease = this.getBlobLease(res, context);

      const snapshot = this.getModelValue<string>(res, "snapshot", true);
      // check the lease action aligned with current lease state.
      if (snapshot !== "") {
        throw StorageErrorFactory.getBlobSnapshotsPresent(context.contextId!);
      }
      if (
        lease.leaseState === Models.LeaseStateType.Available ||
        lease.leaseState === Models.LeaseStateType.Expired ||
        lease.leaseState === Models.LeaseStateType.Broken
      ) {
        throw StorageErrorFactory.getBlobLeaseNotPresentWithLeaseOperation(
          context.contextId!
        );
      }
      if (lease.leaseState === Models.LeaseStateType.Breaking) {
        throw StorageErrorFactory.getLeaseIsBreakingAndCannotBeChanged(
          context.contextId!
        );
      }

      // Check lease ID
      if (lease.leaseId !== leaseId && lease.leaseId !== proposedLeaseId) {
        throw StorageErrorFactory.getBlobLeaseIdMismatchWithLeaseOperation(
          context.contextId!
        );
      }

      // update the lease information, only need update lease ID
      lease.leaseId = proposedLeaseId;

      const properties: Models.BlobProperties = {
        etag: this.getModelValue<string>(res, "etag", true),
        lastModified: this.getModelValue<Date>(res, "lastModified", true)
      };

      await BlobsModel.update(
        {
          leaseStatus: lease.leaseStatus ? lease.leaseStatus : null,
          leaseState: lease.leaseState ? lease.leaseState : null,
          leaseDuration: lease.leaseDurationType
            ? lease.leaseDurationType
            : null,
          leaseId: lease.leaseId ? lease.leaseId : null,
          leasedurationNumber: lease.leaseDurationSeconds
            ? lease.leaseDurationSeconds
            : null,
          leaseExpireTime: lease.leaseExpireTime ? lease.leaseExpireTime : null,
          leaseBreakExpireTime: lease.leaseBreakTime
            ? lease.leaseBreakTime
            : null
        },
        {
          where: {
            accountName: account,
            containerName: container,
            blobName: blob,
            snapshot: "",
            deleting: 0
          },
          transaction: t
        }
      );
      return { properties, leaseId: lease.leaseId };
    });
  }

  public async breakBlobLease(
    context: Context,
    account: string,
    container: string,
    blob: string,
    breakPeriod: number | undefined
  ): Promise<BreakBlobLeaseResponse> {
    return this.sequelize.transaction(async t => {
      const containerRes = await ContainersModel.findOne({
        attributes: ["accountName"],
        where: {
          accountName: account,
          containerName: container
        },
        transaction: t
      });

      const requestId = context ? context.contextId : undefined;
      if (containerRes === null || containerRes === undefined) {
        throw StorageErrorFactory.getContainerNotFound(requestId);
      }

      const res = await BlobsModel.findOne({
        where: {
          accountName: account,
          containerName: container,
          blobName: blob,
          snapshot: "",
          deleting: 0
        },
        transaction: t
      });

      if (res === null || res === undefined) {
        throw StorageErrorFactory.getBlobNotFound(requestId);
      }

      const lease = this.getBlobLease(res, context);

      let leaseTimeinSecond: number = 0;
      const snapshot = this.getModelValue<string>(res, "snapshot", true);
      // check the lease action aligned with current lease state.
      if (snapshot !== "") {
        throw StorageErrorFactory.getBlobSnapshotsPresent(context.contextId!);
      }
      if (lease.leaseState === Models.LeaseStateType.Available) {
        throw StorageErrorFactory.getBlobLeaseNotPresentWithLeaseOperation(
          context.contextId!
        );
      }

      // update the lease information
      // verify options.breakPeriod between 0 and 60
      if (breakPeriod !== undefined && (breakPeriod > 60 || breakPeriod < 0)) {
        throw StorageErrorFactory.getInvalidLeaseBreakPeriod(
          context.contextId!
        );
      }
      if (
        lease.leaseState === Models.LeaseStateType.Expired ||
        lease.leaseState === Models.LeaseStateType.Broken ||
        breakPeriod === 0 ||
        breakPeriod === undefined
      ) {
        lease.leaseState = Models.LeaseStateType.Broken;
        lease.leaseStatus = Models.LeaseStatusType.Unlocked;
        lease.leaseDurationType = undefined;
        lease.leaseDurationSeconds = undefined;
        lease.leaseExpireTime = undefined;
        lease.leaseBreakTime = undefined;
        leaseTimeinSecond = 0;
      } else {
        lease.leaseState = Models.LeaseStateType.Breaking;
        lease.leaseStatus = Models.LeaseStatusType.Locked;
        lease.leaseDurationSeconds = undefined;
        if (lease.leaseDurationType === Models.LeaseDurationType.Infinite) {
          lease.leaseDurationType = undefined;
          lease.leaseExpireTime = undefined;
          lease.leaseBreakTime = new Date(context.startTime!);
          lease.leaseBreakTime.setSeconds(
            lease.leaseBreakTime.getSeconds() + breakPeriod
          );
          leaseTimeinSecond = breakPeriod;
        } else {
          let newleaseBreakExpireTime = new Date(context.startTime!);
          newleaseBreakExpireTime.setSeconds(
            newleaseBreakExpireTime.getSeconds() + breakPeriod
          );
          if (
            lease.leaseExpireTime !== undefined &&
            newleaseBreakExpireTime > lease.leaseExpireTime
          ) {
            newleaseBreakExpireTime = lease.leaseExpireTime;
          }
          if (
            lease.leaseBreakTime === undefined ||
            lease.leaseBreakTime > newleaseBreakExpireTime
          ) {
            lease.leaseBreakTime = newleaseBreakExpireTime;
          }
          leaseTimeinSecond = Math.round(
            Math.abs(
              lease.leaseBreakTime.getTime() - context.startTime!.getTime()
            ) / 1000
          );
          lease.leaseExpireTime = undefined;
          lease.leaseDurationType = undefined;
        }
      }

      const properties: Models.BlobProperties = {
        etag: this.getModelValue<string>(res, "etag", true),
        lastModified: this.getModelValue<Date>(res, "lastModified", true)
      };

      await BlobsModel.update(
        {
          leaseStatus: lease.leaseStatus ? lease.leaseStatus : null,
          leaseState: lease.leaseState ? lease.leaseState : null,
          leaseDuration: lease.leaseDurationType
            ? lease.leaseDurationType
            : null,
          leaseId: lease.leaseId ? lease.leaseId : null,
          leasedurationNumber: lease.leaseDurationSeconds
            ? lease.leaseDurationSeconds
            : null,
          leaseExpireTime: lease.leaseExpireTime ? lease.leaseExpireTime : null,
          leaseBreakExpireTime: lease.leaseBreakTime
            ? lease.leaseBreakTime
            : null
        },
        {
          where: {
            accountName: account,
            containerName: container,
            blobName: blob,
            snapshot: "",
            deleting: 0
          },
          transaction: t
        }
      );
      return { properties, leaseTime: leaseTimeinSecond };
    });
  }

  public async checkBlobExist(
    context: Context,
    account: string,
    container: string,
    blob: string,
    snapshot?: string | undefined
  ): Promise<void> {
    await this.sequelize.transaction(async t => {
      const containerRes = await ContainersModel.findOne({
        attributes: ["accountName"],
        where: {
          accountName: account,
          containerName: container
        },
        transaction: t
      });

      const requestId = context ? context.contextId : undefined;
      if (containerRes === null || containerRes === undefined) {
        throw StorageErrorFactory.getContainerNotFound(requestId);
      }

      const res = await BlobsModel.findOne({
        where: {
          accountName: account,
          containerName: container,
          blobName: blob,
          snapshot: snapshot ? snapshot : "",
          deleting: 0
        },
        transaction: t
      });

      if (res === null || res === undefined) {
        throw StorageErrorFactory.getBlobNotFound(requestId);
      }
    });
  }

  public async getBlobType(
    account: string,
    container: string,
    blob: string,
    snapshot?: string | undefined
  ): Promise<
    { blobType: Models.BlobType | undefined; isCommitted: boolean } | undefined
  > {
    const res = await BlobsModel.findOne({
      where: {
        accountName: account,
        containerName: container,
        blobName: blob,
        snapshot: snapshot ? snapshot : "",
        deleting: 0
      }
    });

    if (res === null || res === undefined) {
      return undefined;
    }

    const blobType = this.getModelValue<Models.BlobType>(res, "blobType", true);
    const isCommitted = this.getModelValue<boolean>(res, "iscommitted", true);

    return { blobType, isCommitted };
  }

  public startCopyFromURL(
    context: Context,
    source: BlobId,
    destination: BlobId,
    copySource: string,
    metadata: Models.BlobMetadata | undefined,
    tier: Models.AccessTier | undefined
  ): Promise<Models.BlobProperties> {
    throw new Error("Method not implemented.");
  }

  public setTier(
    context: Context,
    account: string,
    container: string,
    blob: string,
    tier: Models.AccessTier
  ): Promise<200 | 202> {
    return this.sequelize.transaction(async t => {
      const containerRes = await ContainersModel.findOne({
        attributes: ["accountName"],
        where: {
          accountName: account,
          containerName: container
        },
        transaction: t
      });

      const requestId = context ? context.contextId : undefined;
      if (containerRes === null || containerRes === undefined) {
        throw StorageErrorFactory.getContainerNotFound(requestId);
      }

      const res = await BlobsModel.findOne({
        where: {
          accountName: account,
          containerName: container,
          blobName: blob,
          snapshot: "",
          deleting: 0
        },
        transaction: t
      });

      if (res === null || res === undefined) {
        throw StorageErrorFactory.getBlobNotFound(requestId);
      }

      let responseCode: 200 | 202 = 200;

      // check the lease action aligned with current lease state.
      // the API has not lease ID input, but run it on a lease blocked blob will fail with LeaseIdMissing,
      // this is aligned with server behavior
      const lease = this.getBlobLease(res, context);
      this.checkBlobLeaseOnWriteBlob(
        lease.leaseId,
        lease.leaseStatus,
        undefined,
        requestId
      );
      // Check Blob is not snapshot
      const snapshot = this.getModelValue<string>(res, "snapshot");
      if (snapshot !== "") {
        throw StorageErrorFactory.getBlobSnapshotsPresent(context.contextId!);
      }

      // Check BlobTier matches blob type
      let accessTier = this.getModelValue<Models.AccessTier>(res, "accessTier");
      const blobType = this.getModelValue<Models.BlobType>(res, "blobType");
      if (
        (tier === Models.AccessTier.Archive ||
          tier === Models.AccessTier.Cool ||
          tier === Models.AccessTier.Hot) &&
        blobType === Models.BlobType.BlockBlob
      ) {
        // Block blob
        // tslint:disable-next-line:max-line-length
        // TODO: check blob is not block blob with snapshot, throw StorageErrorFactory.getBlobSnapshotsPresent_hassnapshot()

        // Archive -> Coo/Hot will return 202
        if (
          accessTier === Models.AccessTier.Archive &&
          (tier === Models.AccessTier.Cool || tier === Models.AccessTier.Hot)
        ) {
          responseCode = 202;
        }

        accessTier = tier;
      } else {
        throw StorageErrorFactory.getBlobInvalidBlobType(context.contextId!);
      }
      await BlobsModel.update(
        {
          accessTier,
          accessTierInferred: false,
          accessTierChangeTime: context.startTime
        },
        {
          where: {
            accountName: account,
            containerName: container,
            blobName: blob,
            snapshot: "",
            deleting: 0
          },
          transaction: t
        }
      );

      return responseCode;
    });
  }

  public uploadPages(
    context: Context,
    blob: BlobModel,
    start: number,
    end: number,
    persistencycontext: import("./IBlobMetadataStore").IExtentChunk
  ): Promise<Models.BlobProperties> {
    throw new Error("Method not implemented.");
  }

  public clearRange(
    context: Context,
    blob: BlobModel,
    start: number,
    end: number
  ): Promise<Models.BlobProperties> {
    throw new Error("Method not implemented.");
  }

  public getPageRanges(
    context: Context,
    account: string,
    container: string,
    blob: string,
    snapshot?: string | undefined
  ): Promise<GetPageRangeResponse> {
    throw new Error("Method not implemented.");
  }

  public resizePageBlob(
    context: Context,
    account: string,
    container: string,
    blob: string,
    blobContentLength: number
  ): Promise<Models.BlobProperties> {
    throw new Error("Method not implemented.");
  }

  public updateSequenceNumber(
    context: Context,
    account: string,
    container: string,
    blob: string,
    sequenceNumberAction: Models.SequenceNumberActionType,
    blobSequenceNumber: number | undefined
  ): Promise<Models.BlobProperties> {
    throw new Error("Method not implemented.");
  }

  public async listUncommittedBlockPersistencyChunks(
    marker: string = "-1",
    maxResults: number = 2000
  ): Promise<[IExtentChunk[], string | undefined]> {
    return BlocksModel.findAll({
      attributes: ["id", "persistency"],
      where: {
        id: {
          [Op.gt]: parseInt(marker, 10)
        },
        deleting: 0
      },
      limit: maxResults + 1,
      order: [["id", "ASC"]]
    }).then(res => {
      if (res.length < maxResults) {
        return [
          res.map(obj => {
            return this.deserializeModelValue(obj, "persistency", true);
          }),
          undefined
        ];
      } else {
        res.pop();
        const nextMarker = this.getModelValue<string>(
          res[res.length - 1],
          "id",
          true
        );
        return [
          res.map(obj => this.deserializeModelValue(obj, "persistency", true)),
          nextMarker
        ];
      }
    });
  }

  public iteratorExtents(): AsyncIterator<string[]> {
    return new BlobReferredExtentsAsyncIterator(this);
  }

  private getModelValue<T>(model: Model, key: string): T | undefined;
  private getModelValue<T>(model: Model, key: string, isRequired: true): T;
  private getModelValue<T>(
    model: Model,
    key: string,
    isRequired?: boolean
  ): T | undefined {
    let value = model.get(key) as T | undefined;
    if (value === null) {
      value = undefined;
    }
    if (value === undefined && isRequired === true) {
      // tslint:disable-next-line:max-line-length
      throw new Error(
        `SqlBlobMetadataStore:getModelValue() error. ${key} is required but value from database model is undefined.`
      );
    }
    return value;
  }

  private deserializeModelValue(
    model: Model,
    key: string,
    isRequired: boolean = false
  ): any {
    const rawValue = this.getModelValue<string>(model, key);
    if (typeof rawValue === "string") {
      // TODO: Decouple deserializer
      return JSON.parse(rawValue);
    }

    if (isRequired) {
      throw new Error(
        // tslint:disable-next-line:max-line-length
        `SqlBlobMetadataStore:deserializeModelValue() error. ${key} is required but value from database model is undefined.`
      );
    }

    return undefined;
  }

  private serializeModelValue(value: any): string | undefined {
    if (value === undefined || value === null) {
      return undefined;
    }

    return JSON.stringify(value);
  }

  /**
   * Check Blob lease status on write blob.
   *
   * Need run the funtion on: PutBlob, SetBlobMetadata, SetBlobProperties,
   * DeleteBlob, PutBlock, PutBlockList, PutPage, AppendBlock, CopyBlob(dest)
   *
   * @private
   * @param {Context} context
   * @param {BlobModel} blob
   * @param {LeaseAccessConditions} leaseAccessConditions
   * @returns {void}
   * @memberof BlobHandler
   */
  private checkBlobLeaseOnWriteBlob(
    leaseId: string | undefined,
    leaseStatus: Models.LeaseStatusType | undefined,
    leaseAccessConditions?: Models.LeaseAccessConditions,
    requestId?: string
  ): void {
    // check Leased -> Expired
    if (leaseStatus === Models.LeaseStatusType.Locked) {
      if (
        leaseAccessConditions === undefined ||
        leaseAccessConditions.leaseId === undefined ||
        leaseAccessConditions.leaseId === ""
      ) {
        throw StorageErrorFactory.getBlobLeaseIdMissing(requestId);
      } else if (
        leaseId !== undefined &&
        leaseAccessConditions.leaseId.toLowerCase() !== leaseId.toLowerCase()
      ) {
        throw StorageErrorFactory.getBlobLeaseIdMismatchWithBlobOperation(
          requestId
        );
      }
    } else if (
      leaseAccessConditions !== undefined &&
      leaseAccessConditions.leaseId !== undefined &&
      leaseAccessConditions.leaseId !== ""
    ) {
      throw StorageErrorFactory.getBlobLeaseLost(requestId);
    }
  }

  /**
   * Update lease Expire Blob lease status to Available on write blob.
   *
   * Need run the funtion on: PutBlob, SetBlobMetadata, SetBlobProperties,
   * DeleteBlob, PutBlock, PutBlockList, PutPage, AppendBlock, CopyBlob(dest)
   * @private
   * @param {ILease} blob
   * @returns {ILease}
   * @memberof SqlBlobMetadataStore
   */
  private UpdateBlobLeaseStateOnWriteBlob(blob: ILease): ILease {
    if (
      blob.leaseState === Models.LeaseStateType.Expired ||
      blob.leaseState === Models.LeaseStateType.Broken
    ) {
      blob.leaseState = Models.LeaseStateType.Available;
      blob.leaseStatus = Models.LeaseStatusType.Unlocked;
      blob.leaseDurationType = undefined;
      blob.leaseDurationSeconds = undefined;
      blob.leaseId = undefined;
      blob.leaseExpireTime = undefined;
      blob.leaseBreakTime = undefined;
    }
    return blob;
  }

  /**
   * Calculate container lease attributes from raw values in database records according to the current time.
   *
   * @static
   * @param {ILease} blob
   * @param {Date} currentTime
   * @returns {ILease}
   * @memberof SqlBlobMetadataStore
   */
  private calculateBlobLeaseAttributes(
    blob: ILease,
    currentTime: Date
  ): ILease {
    // check Leased -> Expired
    if (
      blob.leaseState === Models.LeaseStateType.Leased &&
      blob.leaseDurationType === Models.LeaseDurationType.Fixed
    ) {
      if (
        blob.leaseExpireTime !== undefined &&
        currentTime > blob.leaseExpireTime
      ) {
        blob.leaseState = Models.LeaseStateType.Expired;
        blob.leaseStatus = Models.LeaseStatusType.Unlocked;
        blob.leaseDurationType = undefined;
        blob.leaseExpireTime = undefined;
        blob.leaseBreakTime = undefined;
      }
    }

    // check Breaking -> Broken
    if (blob.leaseState === Models.LeaseStateType.Breaking) {
      if (
        blob.leaseBreakTime !== undefined &&
        currentTime > blob.leaseBreakTime
      ) {
        blob.leaseState = Models.LeaseStateType.Broken;
        blob.leaseStatus = Models.LeaseStatusType.Unlocked;
        blob.leaseDurationType = undefined;
        blob.leaseExpireTime = undefined;
        blob.leaseBreakTime = undefined;
      }
    }
    return blob;
  }

  private getBlobLease(blob: BlobsModel, context?: Context): ILease {
    const leaseId = this.getModelValue<string>(blob, "leaseId");
    const leaseStatus = this.getModelValue<Models.LeaseStatusType>(
      blob,
      "leaseStatus"
    );
    const leaseDurationType = this.getModelValue<Models.LeaseDurationType>(
      blob,
      "leaseDuration"
    );
    const leaseState = this.getModelValue<Models.LeaseStateType>(
      blob,
      "leaseState"
    );
    const leasedurationNumber = this.getModelValue<number>(
      blob,
      "leasedurationNumber"
    );
    const leaseExpireTime = this.getModelValue<Date>(blob, "leaseExpireTime");
    const leaseBreakTime = this.getModelValue<Date>(
      blob,
      "leaseBreakExpireTime"
    );

    let lease: ILease = {
      leaseId,
      leaseStatus,
      leaseBreakTime,
      leaseDurationType,
      leaseExpireTime,
      leaseState,
      leaseDurationSeconds: leasedurationNumber
    };

    lease = this.calculateBlobLeaseAttributes(
      lease,
      context ? context.startTime! : new Date()
    );

    return lease;
  }

  /**
   * This method will restore object to Uint8Array.
   *
   * @private
   * @param {*} obj
   * @returns {(Uint8Array | undefined)}
   * @memberof LokiBlobMetadataStore
   */
  private restoreUint8Array(obj: any): Uint8Array | undefined {
    if (typeof obj !== "object") {
      return undefined;
    }

    if (obj instanceof Uint8Array) {
      return obj;
    }

    if (obj.type === "Buffer") {
      obj = obj.data;
    }

    const length = Object.keys(obj).length;
    const arr = Buffer.allocUnsafe(length);

    for (let i = 0; i < length; i++) {
      if (!obj.hasOwnProperty(i)) {
        throw new TypeError(
          `Cannot restore sql DB persisted object to Uint8Array. Key ${i} is missing.`
        );
      }

      arr[i] = obj[i];
    }

    return arr;
  }

  private convertDbModelToContainerModel(
    dbModel: ContainersModel
  ): ContainerModel {
    const accountName = this.getModelValue<string>(
      dbModel,
      "accountName",
      true
    );
    const name = this.getModelValue<string>(dbModel, "containerName", true);
    const containerAcl = this.deserializeModelValue(dbModel, "containerAcl");
    const metadata = this.deserializeModelValue(dbModel, "metadata");

    const lastModified = this.getModelValue<Date>(
      dbModel,
      "lastModified",
      true
    );
    const etag = this.getModelValue<string>(dbModel, "etag", true);
    const publicAccess = this.deserializeModelValue(dbModel, "publicAccess");
    const lease = this.convertDbModelToLease(dbModel);
    const leaseBreakTime = lease.leaseBreakTime;
    const leaseExpireTime = lease.leaseExpireTime;
    const leaseId = lease.leaseId;
    const leaseDurationSeconds = lease.leaseDurationSeconds;
    const leaseStatus = lease.leaseStatus;
    const leaseState = lease.leaseState;
    const leaseDuration = lease.leaseDurationType;
    const hasImmutabilityPolicy = this.getModelValue<boolean>(
      dbModel,
      "hasImmutabilityPolicy"
    );
    const hasLegalHold = this.getModelValue<boolean>(dbModel, "hasLegalHold");

    const ret: ContainerModel = {
      accountName,
      name,
      properties: {
        lastModified,
        etag,
        leaseStatus,
        leaseDuration,
        leaseState
      },
      leaseId,
      leaseBreakTime,
      leaseExpireTime,
      leaseDurationSeconds
    };

    if (metadata !== undefined) {
      ret.metadata = metadata;
    }

    if (containerAcl !== undefined) {
      ret.containerAcl = containerAcl;
    }

    if (publicAccess !== undefined) {
      ret.properties.publicAccess = publicAccess;
    }

    if (hasImmutabilityPolicy !== undefined) {
      ret.properties.hasImmutabilityPolicy = hasImmutabilityPolicy;
    }

    if (hasLegalHold !== undefined) {
      ret.properties.hasLegalHold = hasLegalHold;
    }

    return ret;
  }

  private convertContainerModelToDbModel(container: ContainerModel): object {
    const lease = new ContainerLeaseAdapter(container).toString();
    return {
      accountName: container.accountName,
      containerName: container.name,
      lastModified: container.properties.lastModified,
      etag: container.properties.etag,
      metadata: this.serializeModelValue(container.metadata),
      containerAcl: this.serializeModelValue(container.containerAcl),
      publicAccess: this.serializeModelValue(container.properties.publicAccess),
      lease,
      hasImmutabilityPolicy: container.properties.hasImmutabilityPolicy,
      hasLegalHold: container.properties.hasLegalHold
    };
  }

  private convertDbModelToBlobModel(dbModel: BlobsModel): BlobModel {
    const contentProperties: IBlobContentProperties = this.convertDbModelToBlobContentProperties(
      dbModel
    );

    return {
      accountName: this.getModelValue<string>(dbModel, "accountName", true),
      containerName: this.getModelValue<string>(dbModel, "containerName", true),
      name: this.getModelValue<string>(dbModel, "blobName", true),
      snapshot: this.getModelValue<string>(dbModel, "snapshot", true),
      isCommitted: this.getModelValue<boolean>(dbModel, "isCommitted", true),
      properties: {
        lastModified: this.getModelValue<Date>(dbModel, "lastModified", true),
        etag: this.getModelValue<string>(dbModel, "etag", true),
        leaseDuration: this.getModelValue<Models.LeaseDurationType>(
          dbModel,
          "leaseDuration"
        ),
        creationTime: this.getModelValue<Date>(dbModel, "creationTime"),
        leaseState: this.getModelValue<Models.LeaseStateType>(
          dbModel,
          "leaseState"
        ),
        leaseStatus: this.getModelValue<Models.LeaseStatusType>(
          dbModel,
          "leaseStatus"
        ),
        accessTier: this.getModelValue<Models.AccessTier>(
          dbModel,
          "accessTier"
        ),
        accessTierInferred: this.getModelValue<boolean>(
          dbModel,
          "accessTierInferred"
        ),
        accessTierChangeTime: this.getModelValue<Date>(
          dbModel,
          "accessTierChangeTime"
        ),
        blobSequenceNumber: this.getModelValue<number>(
          dbModel,
          "blobSequenceNumber"
        ),
        blobType: this.getModelValue<Models.BlobType>(dbModel, "blobType"),
        contentMD5: contentProperties
          ? this.restoreUint8Array(contentProperties.contentMD5)
          : undefined,
        contentDisposition: contentProperties
          ? contentProperties.contentDisposition
          : undefined,
        contentEncoding: contentProperties
          ? contentProperties.contentEncoding
          : undefined,
        contentLanguage: contentProperties
          ? contentProperties.contentLanguage
          : undefined,
        contentLength: contentProperties
          ? contentProperties.contentLength
          : undefined,
        contentType: contentProperties
          ? contentProperties.contentType
          : undefined,
        cacheControl: contentProperties
          ? contentProperties.cacheControl
          : undefined
      },
      leaseDurationSeconds: this.getModelValue<number>(
        dbModel,
        "leasedurationNumber"
      ),
      leaseBreakTime: this.getModelValue<Date>(dbModel, "leaseBreakExpireTime"),
      leaseExpireTime: this.getModelValue<Date>(dbModel, "leaseExpireTime"),
      leaseId: this.getModelValue<string>(dbModel, "leaseId"),
      persistency: this.deserializeModelValue(dbModel, "persistency"),
      committedBlocksInOrder: this.deserializeModelValue(
        dbModel,
        "committedBlocksInOrder"
      ),
      metadata: this.deserializeModelValue(dbModel, "metadata")
    };
  }

  private convertBlobModelToDbModel(blob: BlobModel): object {
    const contentProperties = this.convertBlobContentPropertiesToDbModel(
      blob.properties
    );

    return {
      accountName: blob.accountName,
      containerName: blob.containerName,
      blobName: blob.name,
      snapshot: blob.snapshot,
      blobType: blob.properties.blobType,
      blobSequenceNumber: blob.properties.blobSequenceNumber || null,
      isCommitted: true,
      lastModified: blob.properties.lastModified,
      creationTime: blob.properties.creationTime || null,
      etag: blob.properties.etag,
      accessTier: blob.properties.accessTier || null,
      accessTierChangeTime: blob.properties.accessTierChangeTime || null,
      accessTierInferred: blob.properties.accessTierInferred || null,
      leaseBreakExpireTime: blob.leaseBreakTime || null,
      leaseExpireTime: blob.leaseExpireTime || null,
      leaseId: blob.leaseId || null,
      leasedurationNumber: blob.leaseDurationSeconds || null,
      leaseDuration: blob.properties.leaseDuration || null,
      leaseStatus: blob.properties.leaseStatus || null,
      leaseState: blob.properties.leaseState || null,
      persistency: this.serializeModelValue(blob.persistency) || null,
      committedBlocksInOrder:
        this.serializeModelValue(blob.committedBlocksInOrder) || null,
      metadata: this.serializeModelValue(blob.metadata) || null,
      ...contentProperties
    };
  }

  private convertDbModelToBlobContentProperties(
    dbModel: BlobsModel
  ): IBlobContentProperties {
    return this.deserializeModelValue(dbModel, "contentProperties");
  }

  private convertBlobContentPropertiesToDbModel(
    contentProperties: IBlobContentProperties
  ): object {
    return {
      contentProperties:
        this.serializeModelValue({
          contentLength: contentProperties.contentLength,
          contentType: contentProperties.contentType,
          contentEncoding: contentProperties.contentEncoding,
          contentLanguage: contentProperties.contentLanguage,
          contentMD5: contentProperties.contentMD5,
          contentDisposition: contentProperties.contentDisposition,
          cacheControl: contentProperties.cacheControl
        }) || null
    };
  }

  private convertDbModelToLease(dbModel: ContainersModel | BlobsModel): ILease {
    const lease =
      (this.deserializeModelValue(dbModel, "lease") as ILease) || {};

    if (lease.leaseBreakTime && typeof lease.leaseBreakTime === "string") {
      lease.leaseBreakTime = new Date(lease.leaseBreakTime);
    }

    if (lease.leaseExpireTime && typeof lease.leaseExpireTime === "string") {
      lease.leaseExpireTime = new Date(lease.leaseExpireTime);
    }

    return lease;
  }

  private convertLeaseToDbModel(lease: ILease): object {
    let leaseString = "";
    if (lease instanceof ContainerLeaseAdapter) {
      leaseString = lease.toString();
    } else {
      leaseString = JSON.stringify(lease);
    }
    return { lease: leaseString };
  }
}
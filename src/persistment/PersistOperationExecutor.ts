import {PersistOperation} from "./operation/PersistOperation";
import {RemoveOperation} from "./operation/RemoveOperation";
import {UpdateOperation} from "./operation/UpdateOperation";
import {JunctionInsertOperation} from "./operation/JunctionInsertOperation";
import {InsertOperation} from "./operation/InsertOperation";
import {JunctionRemoveOperation} from "./operation/JunctionRemoveOperation";
import {UpdateByRelationOperation} from "./operation/UpdateByRelationOperation";
import {Broadcaster} from "../subscriber/Broadcaster";
import {EntityMetadataCollection} from "../metadata-args/collection/EntityMetadataCollection";
import {Driver} from "../driver/Driver";
import {UpdateByInverseSideOperation} from "./operation/UpdateByInverseSideOperation";
import {RelationMetadata} from "../metadata/RelationMetadata";
import {ObjectLiteral} from "../common/ObjectLiteral";
import {QueryRunner} from "../driver/QueryRunner";

/**
 * Executes PersistOperation in the given connection.
 */
export class PersistOperationExecutor {

    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------
    
    constructor(private driver: Driver,
                private entityMetadatas: EntityMetadataCollection,
                private broadcaster: Broadcaster,
                private queryRunner: QueryRunner) {
    }

    // -------------------------------------------------------------------------
    // Public Methods
    // -------------------------------------------------------------------------

    /**
     * Executes given persist operation.
     */
    executePersistOperation(persistOperation: PersistOperation) {
        let isTransactionStartedByItself = false;

        // persistOperation.log();

        return Promise.resolve()
            .then(() => this.broadcastBeforeEvents(persistOperation))
            .then(() => {
                if (!this.queryRunner.isTransactionActive) {
                    isTransactionStartedByItself = true;
                    return this.queryRunner.beginTransaction();
                }

                return undefined;
            })
            .then(() => this.executeInsertOperations(persistOperation))
            .then(() => this.executeInsertClosureTableOperations(persistOperation))
            .then(() => this.executeUpdateTreeLevelOperations(persistOperation))
            .then(() => this.executeInsertJunctionsOperations(persistOperation))
            .then(() => this.executeRemoveJunctionsOperations(persistOperation))
            .then(() => this.executeRemoveRelationOperations(persistOperation))
            .then(() => this.executeUpdateRelationsOperations(persistOperation))
            .then(() => this.executeUpdateInverseRelationsOperations(persistOperation))
            .then(() => this.executeUpdateOperations(persistOperation))
            .then(() => this.executeRemoveOperations(persistOperation))
            .then(() => {
                if (isTransactionStartedByItself === true)
                    return this.queryRunner.commitTransaction();

                return Promise.resolve();
            })
            .then(() => this.updateIdsOfInsertedEntities(persistOperation))
            .then(() => this.updateIdsOfRemovedEntities(persistOperation))
            .then(() => this.updateSpecialColumnsInEntities(persistOperation))
            .then(() => this.broadcastAfterEvents(persistOperation))
            .catch(error => {
                if (isTransactionStartedByItself === true) {
                    return this.queryRunner.rollbackTransaction()
                        .then(() => {
                            throw error;
                        })
                        .catch(() => {
                            throw error;
                        });
                }
                throw error;
            });
    }

    // -------------------------------------------------------------------------
    // Private Methods
    // -------------------------------------------------------------------------

    /**
     * Broadcast all before persistment events - beforeInsert, beforeUpdate and beforeRemove events.
     */
    private broadcastBeforeEvents(persistOperation: PersistOperation) {

        const insertEvents = persistOperation.inserts.map(insertOperation => {
            const persistedEntityWithId = persistOperation.allPersistedEntities.find(e => e.entity === insertOperation.entity);
            if (!persistedEntityWithId)
                throw new Error(`Persisted entity was not found`);
            
            return this.broadcaster.broadcastBeforeInsertEvent(persistedEntityWithId.entity);
        });
        const updateEvents = persistOperation.updates.map(updateOperation => {
            const persistedEntityWithId = persistOperation.allPersistedEntities.find(e => e.entity === updateOperation.entity);
            if (!persistedEntityWithId)
                throw new Error(`Persisted entity was not found`);
            
            return this.broadcaster.broadcastBeforeUpdateEvent(persistedEntityWithId.entity, updateOperation.columns);
        });
        const removeEvents = persistOperation.removes.map(removeOperation => {
            // we can send here only dbEntity, not entity from the persisted object, since entity from the persisted
            // object does not exist anymore - its removed, and there is no way to find this removed object
            return this.broadcaster.broadcastBeforeRemoveEvent(removeOperation.entity, removeOperation.entityId);
        });
        
        return Promise.all(insertEvents)
            .then(() => Promise.all(updateEvents))
            .then(() => Promise.all(removeEvents)); // todo: do we really should send it in order?
    }

    /**
     * Broadcast all after persistment events - afterInsert, afterUpdate and afterRemove events.
     */
    private broadcastAfterEvents(persistOperation: PersistOperation) {
        
        const insertEvents = persistOperation.inserts.map(insertOperation => {
            const persistedEntity = persistOperation.allPersistedEntities.find(e => e.entity === insertOperation.entity);
            if (!persistedEntity)
                throw new Error(`Persisted entity was not found`);
            
            return this.broadcaster.broadcastAfterInsertEvent(persistedEntity.entity);
        });
        const updateEvents = persistOperation.updates.map(updateOperation => {
            const persistedEntityWithId = persistOperation.allPersistedEntities.find(e => e.entity === updateOperation.entity);
            if (!persistedEntityWithId)
                throw new Error(`Persisted entity was not found`);
            
            return this.broadcaster.broadcastAfterUpdateEvent(persistedEntityWithId.entity, updateOperation.columns);
        });
        const removeEvents = persistOperation.removes.map(removeOperation => {
            // we can send here only dbEntity, not entity from the persisted object, since entity from the persisted
            // object does not exist anymore - its removed, and there is no way to find this removed object
            return this.broadcaster.broadcastAfterRemoveEvent(removeOperation.entity, removeOperation.entityId);
        });
        
        return Promise.all(insertEvents)
            .then(() => Promise.all(updateEvents))
            .then(() => Promise.all(removeEvents)); // todo: do we really should send it in order?
    }

    /**
     * Executes insert operations.
     */
    private executeInsertOperations(persistOperation: PersistOperation) {
        return Promise.all(persistOperation.inserts.map(operation => {
            return this.insert(operation).then((insertId: any) => {
                const metadata = this.entityMetadatas.findByTarget(operation.target);
                if (insertId && metadata.hasGeneratedColumn) {
                    operation.entityId = { [metadata.generatedColumn.propertyName]: insertId };
                }
            });
        }));
    }

    /**
     * Executes insert operations for closure tables.
     */
    private executeInsertClosureTableOperations(persistOperation: PersistOperation) {
        const promises = persistOperation.inserts
            .filter(operation => {
                const metadata = this.entityMetadatas.findByTarget(operation.target);
                return metadata.table.isClosure;
            })
            .map(operation => {
                const relationsUpdateMap = this.findUpdateOperationForEntity(persistOperation.updatesByRelations, persistOperation.inserts, operation.entity);
                return this.insertIntoClosureTable(operation, relationsUpdateMap).then(level => {
                    operation.treeLevel = level;
                });
            });
        return Promise.all(promises);
    }

    /**
     * Executes update tree level operations in inserted entities right after data into closure table inserted.
     */
    private executeUpdateTreeLevelOperations(persistOperation: PersistOperation) {
        return Promise.all(persistOperation.inserts.map(operation => {
            return this.updateTreeLevel(operation);
        }));
    }

    /**
     * Executes insert junction operations.
     */
    private executeInsertJunctionsOperations(persistOperation: PersistOperation) {
        return Promise.all(persistOperation.junctionInserts.map(junctionOperation => {
            return this.insertJunctions(junctionOperation, persistOperation.inserts);
        }));
    }

    /**
     * Executes remove junction operations.
     */
    private executeRemoveJunctionsOperations(persistOperation: PersistOperation) {
        return Promise.all(persistOperation.junctionRemoves.map(junctionOperation => {
            return this.removeJunctions(junctionOperation);
        }));
    }

    /**
     * Executes update relations operations.
     */
    private executeUpdateRelationsOperations(persistOperation: PersistOperation) {
        return Promise.all(persistOperation.updatesByRelations.map(updateByRelation => {
            return this.updateByRelation(updateByRelation, persistOperation.inserts);
        }));
    }

    /**
     * Executes update relations operations.
     */
    private executeUpdateInverseRelationsOperations(persistOperation: PersistOperation) {
        return Promise.all(persistOperation.updatesByInverseRelations.map(updateInverseOperation => {
            return this.updateInverseRelation(updateInverseOperation, persistOperation.inserts);
        }));
    }

    /**
     * Executes update operations.
     */
    private executeUpdateOperations(persistOperation: PersistOperation) {
        return Promise.all(persistOperation.updates.map(updateOperation => {
            return this.update(updateOperation);
        }));
    }

    /**
     * Executes remove relations operations.
     */
    private executeRemoveRelationOperations(persistOperation: PersistOperation) {
        return Promise.all(persistOperation.removes
            .filter(operation => {
                return !!(operation.relation && !operation.relation.isManyToMany && !operation.relation.isOneToMany);
            })
            .map(operation => {
                return this.updateDeletedRelations(operation);
            })
        );
    }

    /**
     * Executes remove operations.
     */
    private executeRemoveOperations(persistOperation: PersistOperation) {
        return Promise.all(persistOperation.removes.map(operation => {
            return this.delete(operation.target, operation.entity);
        }));
    }

    /**
     * Updates all ids of the inserted entities.
     */
    private updateIdsOfInsertedEntities(persistOperation: PersistOperation) {
        persistOperation.inserts.forEach(insertOperation => {
            const metadata = this.entityMetadatas.findByTarget(insertOperation.target);
            metadata.primaryColumns.forEach(primaryColumn => {
                if (insertOperation.entityId)
                    insertOperation.entity[primaryColumn.propertyName] = insertOperation.entityId[primaryColumn.propertyName];
            });
        });
    }

    /**
     * Updates all special columns of the saving entities (create date, update date, versioning).
     */
    private updateSpecialColumnsInEntities(persistOperation: PersistOperation) {
        persistOperation.inserts.forEach(insertOperation => {
            const metadata = this.entityMetadatas.findByTarget(insertOperation.target);
            if (metadata.hasUpdateDateColumn)
                insertOperation.entity[metadata.updateDateColumn.propertyName] = insertOperation.date;
            if (metadata.hasCreateDateColumn)
                insertOperation.entity[metadata.createDateColumn.propertyName] = insertOperation.date;
            if (metadata.hasVersionColumn)
                insertOperation.entity[metadata.versionColumn.propertyName]++;
            if (metadata.hasTreeLevelColumn) {
                // const parentEntity = insertOperation.entity[metadata.treeParentMetadata.propertyName];
                // const parentLevel = parentEntity ? (parentEntity[metadata.treeLevelColumn.propertyName] || 0) : 0;
                insertOperation.entity[metadata.treeLevelColumn.propertyName] = insertOperation.treeLevel;
            }
            /*if (metadata.hasTreeChildrenCountColumn) {
                insertOperation.entity[metadata.treeChildrenCountColumn.propertyName] = 0;
            }*/
        });
        persistOperation.updates.forEach(updateOperation => {
            const metadata = this.entityMetadatas.findByTarget(updateOperation.target);
            if (metadata.hasUpdateDateColumn)
                updateOperation.entity[metadata.updateDateColumn.propertyName] = updateOperation.date;
            if (metadata.hasCreateDateColumn)
                updateOperation.entity[metadata.createDateColumn.propertyName] = updateOperation.date;
            if (metadata.hasVersionColumn)
                updateOperation.entity[metadata.versionColumn.propertyName]++;
        });
    }

    /**
     * Removes all ids of the removed entities.
     */
    private updateIdsOfRemovedEntities(persistOperation: PersistOperation) {
        persistOperation.removes.forEach(removeOperation => {
            const metadata = this.entityMetadatas.findByTarget(removeOperation.target);
            const removedEntity = persistOperation.allPersistedEntities.find(allNewEntity => {
                return allNewEntity.entityTarget === removeOperation.target && allNewEntity.compareId(metadata.getEntityIdMap(removeOperation.entity)!);
            });
            if (removedEntity) {
                metadata.primaryColumns.forEach(primaryColumn => {
                    removedEntity.entity[primaryColumn.propertyName] = undefined;
                });
            }
        });
    }

    private findUpdateOperationForEntity(operations: UpdateByRelationOperation[], insertOperations: InsertOperation[], target: any): ObjectLiteral {
        // we are using firstPrimaryColumn here because this method is used only in executeInsertClosureTableOperations method
        // which means only for tree tables, but multiple primary keys are not supported in tree tables

        let updateMap: ObjectLiteral = {};
        operations
            .forEach(operation => { // duplication with updateByRelation method
                const metadata = this.entityMetadatas.findByTarget(operation.insertOperation.target);
                const relatedInsertOperation = insertOperations.find(o => o.entity === operation.targetEntity);
                if (operation.updatedRelation.isOneToMany) {
                    const idInInserts = relatedInsertOperation && relatedInsertOperation.entityId ? relatedInsertOperation.entityId[metadata.firstPrimaryColumn.propertyName] : null;
                    if (operation.insertOperation.entity === target)
                        updateMap[operation.updatedRelation.inverseRelation.propertyName] = operation.targetEntity[metadata.firstPrimaryColumn.propertyName] || idInInserts;

                } else {
                    if (operation.targetEntity === target && operation.insertOperation.entityId)
                        updateMap[operation.updatedRelation.propertyName] = operation.insertOperation.entityId[metadata.firstPrimaryColumn.propertyName];
                }
            });

        return updateMap;
    }

    private updateByRelation(operation: UpdateByRelationOperation, insertOperations: InsertOperation[]) {

        if (!operation.insertOperation.entityId)
            throw new Error(`insert operation does not have entity id`);

        let tableName: string, relationName: string, relationId: ObjectLiteral, idColumn: string, id: any, updateMap: ObjectLiteral;
        const relatedInsertOperation = insertOperations.find(o => o.entity === operation.targetEntity);

        if (operation.updatedRelation.isOneToMany || operation.updatedRelation.isOneToOneNotOwner) {
            const metadata = this.entityMetadatas.findByTarget(operation.insertOperation.target);
            const idInInserts = relatedInsertOperation && relatedInsertOperation.entityId ? relatedInsertOperation.entityId[metadata.firstPrimaryColumn.propertyName] : null;
            tableName = metadata.table.name;
            relationName = operation.updatedRelation.inverseRelation.name;
            relationId = operation.targetEntity[metadata.firstPrimaryColumn.propertyName] || idInInserts; // todo: make sure idInInserts is always a map
            // relationId = operation.targetEntity[metadata.primaryColumn.propertyName] || idInInserts;
            // idColumn = metadata.primaryColumn.name;
            // id = operation.insertOperation.entityId;

            updateMap = operation.insertOperation.entityId;

        } else {
            const metadata = this.entityMetadatas.findByTarget(operation.entityTarget);
            const idInInserts = relatedInsertOperation && relatedInsertOperation.entityId ? relatedInsertOperation.entityId[metadata.firstPrimaryColumn.propertyName] : null;
            tableName = metadata.table.name;
            relationName = operation.updatedRelation.name;
            relationId = operation.insertOperation.entityId[metadata.firstPrimaryColumn.propertyName]; // todo: make sure entityId is always a map
            // idColumn = metadata.primaryColumn.name;
            // id = operation.targetEntity[metadata.primaryColumn.propertyName] || idInInserts;
            updateMap = metadata.getEntityIdMap(operation.targetEntity) || idInInserts; // todo: make sure idInInserts always object even when id is single!!!
        }
        return this.queryRunner.update(tableName, { [relationName]: relationId }, updateMap);
    }

    private updateInverseRelation(operation: UpdateByInverseSideOperation, insertOperations: InsertOperation[]) {
        const targetEntityMetadata = this.entityMetadatas.findByTarget(operation.entityTarget);
        const fromEntityMetadata = this.entityMetadatas.findByTarget(operation.fromEntityTarget);
        const tableName = targetEntityMetadata.table.name;
        const targetRelation = operation.fromRelation.inverseRelation;
        const updateMap = targetEntityMetadata.getEntityIdMap(operation.targetEntity);
        if (!updateMap) return; // todo: is return correct here?

        const fromEntityInsertOperation = insertOperations.find(o => o.entity === operation.fromEntity);
        let targetEntityId: any; // todo: better do it during insertion - pass UpdateByInverseSideOperation[] to insert and do it there
        if (operation.operationType === "remove") {
            targetEntityId = null;
        } else {
            if (fromEntityInsertOperation && fromEntityInsertOperation.entityId && targetRelation.joinColumn.referencedColumn === fromEntityMetadata.firstPrimaryColumn) {
                targetEntityId = fromEntityInsertOperation.entityId[fromEntityMetadata.firstPrimaryColumn.name];
            } else {
                targetEntityId = operation.fromEntity[targetRelation.joinColumn.referencedColumn.name];
            }
        }
        
        return this.queryRunner.update(tableName, { [targetRelation.name]: targetEntityId }, updateMap);
    }

    private update(updateOperation: UpdateOperation) {
        const entity = updateOperation.entity;
        const metadata = this.entityMetadatas.findByTarget(updateOperation.target);
        const values: ObjectLiteral = {};
        
        updateOperation.columns.forEach(column => {
            values[column.name] = this.driver.preparePersistentValue(column.getEntityValue(entity), column);
        });
        
        updateOperation.relations.forEach(relation => {
            const value = this.getEntityRelationValue(relation, entity);
            values[relation.name] = value !== null && value !== undefined ? value[relation.inverseEntityMetadata.firstPrimaryColumn.propertyName] : null; // todo: should not have a call to primaryColumn, instead join column metadata should be used
        });

        // if number of updated columns = 0 no need to update updated date and version columns
        if (Object.keys(values).length === 0)
            return Promise.resolve();

        if (metadata.hasUpdateDateColumn)
            values[metadata.updateDateColumn.name] = this.driver.preparePersistentValue(new Date(), metadata.updateDateColumn);

        if (metadata.hasVersionColumn)
            values[metadata.versionColumn.name] = this.driver.preparePersistentValue(entity[metadata.versionColumn.propertyName] + 1, metadata.versionColumn);
        
        return this.queryRunner.update(metadata.table.name, values, metadata.getEntityIdMap(entity)!);
    }

    private updateDeletedRelations(removeOperation: RemoveOperation) { // todo: check if both many-to-one deletions work too
        if (!removeOperation.fromEntityId)
            throw new Error(`remove operation does not have entity id`);

        if (removeOperation.relation) {
            return this.queryRunner.update(
                removeOperation.fromMetadata.table.name,
                { [removeOperation.relation.name]: null },
                removeOperation.fromEntityId
            );   
        }

        throw new Error("Remove operation relation is not set"); // todo: find out how its possible
    }

    private delete(target: Function|string, entity: any) {
        const metadata = this.entityMetadatas.findByTarget(target);
        return this.queryRunner.delete(metadata.table.name, metadata.getEntityIdMap(entity)!);
    }

    private insert(operation: InsertOperation) {
        const entity = operation.entity;
        const metadata = this.entityMetadatas.findByTarget(operation.target);
        
        const columns = metadata.columns
            .filter(column => !column.isVirtual && column.hasEntityValue(entity));
        
        const columnNames = columns.map(column => column.name);
        const values = columns.map(column => this.driver.preparePersistentValue(column.getEntityValue(entity), column));
        
        const relationColumns = metadata.relations
            .filter(relation => !relation.isManyToMany && relation.isOwning && !!relation.inverseEntityMetadata)
            .filter(relation => entity.hasOwnProperty(relation.propertyName))
            .map(relation => relation.name);

        const relationValues = metadata.relations
            .filter(relation => !relation.isManyToMany && relation.isOwning && !!relation.inverseEntityMetadata)
            .filter(relation => entity.hasOwnProperty(relation.propertyName))
            .map(relation => {
                const value = this.getEntityRelationValue(relation, entity);
                if (value !== null && value !== undefined) // in the case if relation has null, which can be saved
                    return value[relation.inverseEntityMetadata.firstPrimaryColumn.propertyName]; // todo: it should be get by field set in join column in the relation metadata

                return value;
            });

        const allColumns = columnNames.concat(relationColumns);
        const allValues = values.concat(relationValues);

        if (metadata.hasCreateDateColumn) {
            allColumns.push(metadata.createDateColumn.name);
            allValues.push(this.driver.preparePersistentValue(operation.date, metadata.createDateColumn));
        }

        if (metadata.hasUpdateDateColumn) {
            allColumns.push(metadata.updateDateColumn.name);
            allValues.push(this.driver.preparePersistentValue(operation.date, metadata.updateDateColumn));
        }

        if (metadata.hasVersionColumn) {
            allColumns.push(metadata.versionColumn.name);
            allValues.push(this.driver.preparePersistentValue(1, metadata.versionColumn));
        }
        
        if (metadata.hasTreeLevelColumn && metadata.hasTreeParentRelation) {
            const parentEntity = entity[metadata.treeParentRelation.name]; // todo: are you sure here we should use name and not propertyName ?
            const parentLevel = parentEntity ? (parentEntity[metadata.treeLevelColumn.propertyName] || 0) : 0;
            
            allColumns.push(metadata.treeLevelColumn.name);
            allValues.push(parentLevel + 1);
        }
        
        /*if (metadata.hasTreeChildrenCountColumn) {
            allColumns.push(metadata.treeChildrenCountColumn.name);
            allValues.push(0);
        }*/

        // console.log("inserting: ", this.zipObject(allColumns, allValues));
        let generatedColumn = metadata.columns.find(column => column.isGenerated);
        return this.queryRunner.insert(metadata.table.name, this.zipObject(allColumns, allValues), generatedColumn);
    }

    private insertIntoClosureTable(operation: InsertOperation, updateMap: ObjectLiteral) {
        // here we can only support to work only with single primary key entities

        const entity = operation.entity;
        const metadata = this.entityMetadatas.findByTarget(operation.target);
        const parentEntity = entity[metadata.treeParentRelation.propertyName];

        let parentEntityId: any = 0;
        if (parentEntity && parentEntity[metadata.firstPrimaryColumn.propertyName]) {
            parentEntityId = parentEntity[metadata.firstPrimaryColumn.propertyName];

        } else if (updateMap && updateMap[metadata.treeParentRelation.propertyName]) { // todo: name or propertyName: depend how update will be implemented. or even find relation of this treeParent and use its name?
            parentEntityId = updateMap[metadata.treeParentRelation.propertyName];
        }

        if (!operation.entityId)
            throw new Error(`operation does not have entity id`);

        return this.queryRunner.insertIntoClosureTable(metadata.closureJunctionTable.table.name, operation.entityId[metadata.firstPrimaryColumn.propertyName], parentEntityId, metadata.hasTreeLevelColumn)
            /*.then(() => {
                // we also need to update children count in parent
                if (parentEntity && parentEntityId) {
                    const values = { [metadata.treeChildrenCountColumn.name]: parentEntity[metadata.treeChildrenCountColumn.name] + 1 };
                    return this.driver.update(metadata.table.name, values, { [metadata.primaryColumn.name]: parentEntityId });
                }
                return;
            })*/;
    }

    private updateTreeLevel(operation: InsertOperation) {
        const metadata = this.entityMetadatas.findByTarget(operation.target);

        if (metadata.hasTreeLevelColumn && operation.treeLevel) {
            if (!operation.entityId)
                throw new Error(`remove operation does not have entity id`);

            const values = { [metadata.treeLevelColumn.name]: operation.treeLevel };
            return this.queryRunner.update(metadata.table.name, values, operation.entityId);
        }
        
        return Promise.resolve();

    }

    private insertJunctions(junctionOperation: JunctionInsertOperation, insertOperations: InsertOperation[]) {
        // I think here we can only support to work only with single primary key entities

        const junctionMetadata = junctionOperation.metadata;
        const metadata1 = this.entityMetadatas.findByTarget(junctionOperation.entity1Target);
        const metadata2 = this.entityMetadatas.findByTarget(junctionOperation.entity2Target);
        const columns = junctionMetadata.columns.map(column => column.name);
        const insertOperation1 = insertOperations.find(o => o.entity === junctionOperation.entity1);
        const insertOperation2 = insertOperations.find(o => o.entity === junctionOperation.entity2);

        let id1 = junctionOperation.entity1[metadata1.firstPrimaryColumn.propertyName];
        let id2 = junctionOperation.entity2[metadata2.firstPrimaryColumn.propertyName];
        
        if (!id1) {
            if (insertOperation1 && insertOperation1.entityId) {
                id1 = insertOperation1.entityId[metadata1.firstPrimaryColumn.propertyName];
            } else {
                throw new Error(`Insert operation for ${junctionOperation.entity1} was not found.`);
            }
        } 
        
        if (!id2) {
            if (insertOperation2 && insertOperation2.entityId) {
                id2 = insertOperation2.entityId[metadata2.firstPrimaryColumn.propertyName];
            } else {
                throw new Error(`Insert operation for ${junctionOperation.entity2} was not found.`);
            }
        }
        
        let values: any[]; 
        // order may differ, find solution (column.table to compare with entity metadata table?)
        if (metadata1.table === junctionMetadata.foreignKeys[0].referencedTable) {
            values = [id1, id2];
        } else {
            values = [id2, id1];
        }
        
        return this.queryRunner.insert(junctionMetadata.table.name, this.zipObject(columns, values));
    }

    private removeJunctions(junctionOperation: JunctionRemoveOperation) {
        // I think here we can only support to work only with single primary key entities
        const junctionMetadata = junctionOperation.metadata;
        const metadata1 = this.entityMetadatas.findByTarget(junctionOperation.entity1Target);
        const metadata2 = this.entityMetadatas.findByTarget(junctionOperation.entity2Target);
        const columns = junctionMetadata.columns.map(column => column.name);
        const id1 = junctionOperation.entity1[metadata1.firstPrimaryColumn.propertyName];
        const id2 = junctionOperation.entity2[metadata2.firstPrimaryColumn.propertyName];
        return this.queryRunner.delete(junctionMetadata.table.name, { [columns[0]]: id1, [columns[1]]: id2 });
    }

    private zipObject(keys: any[], values: any[]): Object {
        return keys.reduce((object, column, index) => {
            (<any> object)[column] = values[index];
            return object;
        }, {});
    }

    private getEntityRelationValue(relation: RelationMetadata, entity: any) {
        return relation.isLazy ? entity["__" + relation.propertyName + "__"] : entity[relation.propertyName];
    }

}
package org.dias.mobile.data

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import org.dias.mobile.domain.CasePage
import org.dias.mobile.domain.CaseSummary
import org.dias.mobile.domain.LocalCases
import org.dias.mobile.domain.SyncState

class CaseDatabase(context: Context, name: String = "dias-summaries.db") :
    SQLiteOpenHelper(context.applicationContext, name, null, 1), LocalCases {

    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL("""CREATE TABLE case_summary (
            scope TEXT NOT NULL, case_id TEXT NOT NULL, owning_agency TEXT NOT NULL,
            jurisdiction TEXT NOT NULL, status TEXT NOT NULL,
            PRIMARY KEY(scope, case_id))""")
        db.execSQL("""CREATE TABLE sync_state (
            scope TEXT PRIMARY KEY NOT NULL, cursor TEXT, complete INTEGER NOT NULL,
            fetched_at INTEGER NOT NULL)""")
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
        throw IllegalStateException("A versioned migration is required")
    }

    override fun read(scope: String, limit: Int, offset: Int): List<CaseSummary> {
        require(limit in 1..50 && offset >= 0)
        return readableDatabase.rawQuery("""SELECT case_id, owning_agency, jurisdiction, status
            FROM case_summary WHERE scope = ? ORDER BY case_id LIMIT ? OFFSET ?""",
            arrayOf(scope, limit.toString(), offset.toString())).use { cursor ->
            buildList {
                while (cursor.moveToNext()) add(CaseSummary(cursor.getString(0), cursor.getString(1),
                    cursor.getString(2), cursor.getString(3)))
            }
        }
    }

    override fun count(scope: String): Int = readableDatabase.rawQuery(
        "SELECT COUNT(*) FROM case_summary WHERE scope = ?", arrayOf(scope)).use {
        it.moveToFirst(); it.getInt(0)
    }

    override fun state(scope: String): SyncState? = readableDatabase.rawQuery(
        "SELECT cursor, complete, fetched_at FROM sync_state WHERE scope = ?", arrayOf(scope)).use {
        if (!it.moveToFirst()) null else SyncState(
            if (it.isNull(0)) null else it.getString(0), it.getInt(1) == 1, it.getLong(2))
    }

    override fun save(scope: String, page: CasePage, replace: Boolean) {
        require(page.items.size <= 50 && (page.items.isNotEmpty() || page.nextCursor == null))
        require(page.items.map { it.caseId }.distinct().size == page.items.size)
        val db = writableDatabase
        db.beginTransaction()
        try {
            if (replace) db.delete("case_summary", "scope = ?", arrayOf(scope))
            page.items.forEach { item ->
                val row = ContentValues().apply {
                    put("scope", scope); put("case_id", item.caseId); put("owning_agency", item.owningAgency)
                    put("jurisdiction", item.jurisdiction); put("status", item.status)
                }
                check(db.insertWithOnConflict("case_summary", null, row,
                    SQLiteDatabase.CONFLICT_REPLACE) != -1L) { "Could not save case summary" }
            }
            val state = ContentValues().apply {
                put("scope", scope); put("cursor", page.nextCursor)
                put("complete", if (page.nextCursor == null) 1 else 0)
                put("fetched_at", System.currentTimeMillis())
            }
            check(db.insertWithOnConflict("sync_state", null, state,
                SQLiteDatabase.CONFLICT_REPLACE) != -1L) { "Could not save page continuation" }
            db.setTransactionSuccessful()
        } finally { db.endTransaction() }
    }

    override fun clear() {
        val db = writableDatabase
        db.beginTransaction()
        try {
            db.delete("case_summary", null, null)
            db.delete("sync_state", null, null)
            db.setTransactionSuccessful()
        } finally { db.endTransaction() }
    }
}

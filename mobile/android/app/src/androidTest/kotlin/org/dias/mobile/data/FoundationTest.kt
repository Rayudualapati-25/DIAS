package org.dias.mobile.data

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.dias.mobile.domain.CasePage
import org.dias.mobile.domain.CaseSummary
import org.dias.mobile.domain.RemoteCases
import org.dias.mobile.domain.Session
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.IOException

@RunWith(AndroidJUnit4::class)
class FoundationTest {
    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext
    private lateinit var database: CaseDatabase
    private val name = "foundation-test.db"
    private val session = Session("https://fixture.example", "fixture", "police", "memory-only")
    private val summaries = (0 until 45).map {
        CaseSummary("CASE-${it.toString().padStart(3, '0')}", "police", "North", "open")
    }

    private inner class FixtureRemote : RemoteCases {
        var online = true
        var requests = 0
        override fun health() { if (!online) throw IOException("offline") }
        override fun login(username: String) = session
        override fun cases(session: Session, cursor: String?, limit: Int): CasePage {
            if (!online) throw IOException("offline")
            requests++
            val start = cursor?.toInt() ?: 0
            val end = (start + limit).coerceAtMost(summaries.size)
            return CasePage(summaries.subList(start, end), if (end == summaries.size) null else "$end")
        }
    }

    @Before fun prepare() { context.deleteDatabase(name); database = CaseDatabase(context, name) }
    @After fun clean() { database.close(); context.deleteDatabase(name) }

    @Test fun batchesPersistAcrossDatabaseReopen() {
        val remote = FixtureRemote()
        var repository = CaseRepository(database, remote)
        assertEquals(20, repository.fetchBatch(session))
        database.close(); database = CaseDatabase(context, name)
        repository = CaseRepository(database, remote)
        assertEquals("20", repository.state(session)!!.cursor)
        assertEquals(20, repository.fetchBatch(session))
        assertEquals(5, repository.fetchBatch(session))
        assertEquals(0, repository.fetchBatch(session))
        assertEquals(3, remote.requests)
        assertEquals(45, repository.count(session))
        assertEquals(summaries.take(20), repository.cached(session, 20, 0))
        assertEquals(summaries.drop(20).take(20), repository.cached(session, 20, 20))
        assertEquals(summaries.drop(40), repository.cached(session, 20, 40))
        assertTrue(repository.state(session)!!.complete)
    }

    @Test fun offlineReadsWorkWhileNetworkOnlyAblationFails() {
        val remote = FixtureRemote()
        val repository = CaseRepository(database, remote)
        repository.fetchBatch(session)
        remote.online = false
        assertEquals(20, repository.cached(session, 20, 0).size)
        assertThrows(IOException::class.java) { remote.cases(session, null, 20) }
        assertThrows(IOException::class.java) { repository.fetchBatch(session) }
        assertEquals(20, repository.count(session))
        assertEquals("20", repository.state(session)!!.cursor)
    }

    @Test fun hostAndAccountCachesAreIsolated() {
        database.save(session.scope, CasePage(summaries.take(20), "20"), true)
        for (other in listOf(session.copy(username = "other"), session.copy(org = "audit"),
            session.copy(baseUrl = "https://another.example"))) {
            assertEquals(0, database.count(other.scope))
            assertNull(database.state(other.scope))
        }
    }

    @Test fun refreshReplacesRemovedCasesAndClearRemovesContinuation() {
        database.save(session.scope, CasePage(summaries.take(20), "20"), true)
        database.save(session.scope, CasePage(summaries.take(1), null), true)
        assertEquals(1, database.count(session.scope))
        database.clear()
        assertEquals(0, database.count(session.scope)); assertNull(database.state(session.scope))
    }

    @Test fun repeatedPageIsIdempotent() {
        val page = CasePage(summaries.take(20), "20")
        database.save(session.scope, page, true)
        database.save(session.scope, page, false)
        assertEquals(20, database.count(session.scope))
    }

    @Test fun failedPageTransactionPreservesRowsAndCursor() {
        database.save(session.scope, CasePage(summaries.take(20), "20"), true)
        database.writableDatabase.execSQL("""CREATE TRIGGER fail_test_insert BEFORE INSERT ON case_summary
            WHEN NEW.case_id = 'CASE-021' BEGIN SELECT RAISE(ABORT, 'test failure'); END""")
        assertThrows(Exception::class.java) {
            database.save(session.scope, CasePage(summaries.drop(20).take(20), "40"), false)
        }
        assertEquals(20, database.count(session.scope))
        assertEquals("20", database.state(session.scope)!!.cursor)
    }

    @Test fun failedRefreshPreservesExistingSnapshot() {
        database.save(session.scope, CasePage(summaries.take(20), "20"), true)
        val remote = FixtureRemote().apply { online = false }
        assertThrows(IOException::class.java) {
            CaseRepository(database, remote).fetchBatch(session, restart = true)
        }
        assertEquals(20, database.count(session.scope))
        assertEquals("20", database.state(session.scope)!!.cursor)
    }
}

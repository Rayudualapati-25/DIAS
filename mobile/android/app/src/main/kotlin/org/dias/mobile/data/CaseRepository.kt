package org.dias.mobile.data

import org.dias.mobile.domain.CaseSummary
import org.dias.mobile.domain.CasesRepository
import org.dias.mobile.domain.LocalCases
import org.dias.mobile.domain.RemoteCases
import org.dias.mobile.domain.Session
import org.dias.mobile.domain.SyncState

class CaseRepository(private val local: LocalCases, private val remote: RemoteCases) : CasesRepository {
    override fun cached(session: Session, limit: Int, offset: Int): List<CaseSummary> =
        local.read(session.scope, limit, offset)
    override fun count(session: Session): Int = local.count(session.scope)
    override fun state(session: Session): SyncState? = local.state(session.scope)
    override fun fetchBatch(session: Session, restart: Boolean): Int {
        val previous = if (restart) null else state(session)
        if (previous?.complete == true) return 0
        val page = remote.cases(session, previous?.cursor, 20)
        local.save(session.scope, page, replace = previous == null)
        return page.items.size
    }
    override fun clear() = local.clear()
}

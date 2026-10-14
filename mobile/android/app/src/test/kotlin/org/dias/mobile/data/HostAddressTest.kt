package org.dias.mobile.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertThrows
import org.junit.Test
import org.dias.mobile.domain.Session

class HostAddressTest {
    @Test fun localDebugAndHttpsAddresses() {
        assertEquals("http://10.0.2.2:3001", HostAddress.normalize(" http://10.0.2.2:3001/ ", true))
        assertEquals("https://demo.ngrok.app", HostAddress.normalize("https://demo.ngrok.app", false))
        assertEquals("https://demo.a.pinggy.link", HostAddress.normalize("https://demo.a.pinggy.link/", true))
    }
    @Test fun invalidOrUnsafeAddresses() {
        for (url in listOf("http://example.com", "https://user:password@host", "https://host/api",
            "https://host?token=secret", "file:///tmp", "https://host:99999", "not a url")) {
            assertThrows(IllegalArgumentException::class.java) { HostAddress.normalize(url, true) }
        }
        assertThrows(IllegalArgumentException::class.java) {
            HostAddress.normalize("http://10.0.2.2:3001", false)
        }
    }
    @Test fun scopeSeparatesHostsAndIdentitiesWithoutUsingToken() {
        val first = Session("https://host", "a", "police", "token")
        assertEquals(first.scope, first.copy(token = "renewed").scope)
        assertNotEquals(first.scope, first.copy(username = "b").scope)
        assertNotEquals(first.scope, first.copy(org = "audit").scope)
        assertNotEquals(first.scope, first.copy(baseUrl = "https://other").scope)
    }
}

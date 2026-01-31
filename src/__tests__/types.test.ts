/**
 * Tests for type definitions and constants
 */

import { describe, it, expect } from 'vitest'
import { STATE_ICONS, STATE_COLORS } from '../core/types.js'
import type { SessionState, SessionMode, SessionStatus, Session } from '../core/types.js'

describe('Types and Constants', () => {
  describe('STATE_ICONS', () => {
    it('should have icons for all session states', () => {
      const states: SessionState[] = ['initializing', 'idle', 'working', 'waiting', 'done', 'error']

      for (const state of states) {
        expect(STATE_ICONS[state]).toBeDefined()
        expect(typeof STATE_ICONS[state]).toBe('string')
        expect(STATE_ICONS[state].length).toBeGreaterThan(0)
      }
    })

    it('should have distinct icons for each state', () => {
      const icons = Object.values(STATE_ICONS)
      const uniqueIcons = new Set(icons)
      expect(uniqueIcons.size).toBe(icons.length)
    })

    it('should use expected icons', () => {
      expect(STATE_ICONS.initializing).toBe('◌')
      expect(STATE_ICONS.idle).toBe('○')
      expect(STATE_ICONS.working).toBe('●')
      expect(STATE_ICONS.waiting).toBe('◐')
      expect(STATE_ICONS.done).toBe('✓')
      expect(STATE_ICONS.error).toBe('✗')
    })
  })

  describe('STATE_COLORS', () => {
    it('should have colors for all session states', () => {
      const states: SessionState[] = ['initializing', 'idle', 'working', 'waiting', 'done', 'error']

      for (const state of states) {
        expect(STATE_COLORS[state]).toBeDefined()
        expect(typeof STATE_COLORS[state]).toBe('string')
      }
    })

    it('should use appropriate colors', () => {
      expect(STATE_COLORS.working).toBe('green')
      expect(STATE_COLORS.waiting).toBe('yellow')
      expect(STATE_COLORS.error).toBe('red')
      expect(STATE_COLORS.done).toBe('cyan')
    })
  })

  describe('Type structures', () => {
    it('should allow valid SessionStatus', () => {
      const status: SessionStatus = {
        state: 'working',
        message: 'Implementing feature',
        lastActivity: new Date(),
        needsInput: undefined,
        progress: 50,
      }

      expect(status.state).toBe('working')
      expect(status.progress).toBe(50)
    })

    it('should allow valid Session', () => {
      const session: Session = {
        id: 'test-session-123',
        displayId: 1,
        branch: 'feature/test',
        worktreePath: '/home/user/.orcha/worktrees/repo/test-session',
        status: {
          state: 'idle',
          message: 'Ready',
          lastActivity: new Date(),
        },
        mode: 'claude',
        pid: 12345,
        createdAt: new Date(),
        repoPath: '/home/user/repo',
      }

      expect(session.id).toBe('test-session-123')
      expect(session.mode).toBe('claude')
    })

    it('should allow all valid SessionModes', () => {
      const modes: SessionMode[] = ['claude', 'gemini', 'codex', 'shell']

      for (const mode of modes) {
        const session: Partial<Session> = { mode }
        expect(session.mode).toBe(mode)
      }
    })
  })
})

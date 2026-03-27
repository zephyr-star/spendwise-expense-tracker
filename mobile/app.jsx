// SpendWise - Production Mobile App
// React + Capacitor hybrid (iOS + Android)
// Full offline-first with sync, themes, accessibility

import React, { createContext, useCallback, useContext, useEffect, useReducer, useRef, useState } from 'react';

// ─── Theme System ──────────────────────────────────────────────────────────────

const THEMES = {
  light: {
    bg: '#F8F9FA', surface: '#FFFFFF', surfaceAlt: '#F1F3F5',
    border: '#E9ECEF', text: '#1A1A2E', textSub: '#6C757D',
    primary: '#4F46E5', primaryLight: '#EEF2FF',
    success: '#10B981', warning: '#F59E0B', danger: '#EF4444',
    card: '#FFFFFF', shadow: 'rgba(0,0,0,0.08)',
  },
  dark: {
    bg: '#0F0F1A', surface: '#1A1A2E', surfaceAlt: '#16213E',
    border: '#2D2D44', text: '#F0F0FF', textSub: '#9090B0',
    primary: '#6366F1', primaryLight: '#1E1B4B',
    success: '#10B981', warning: '#F59E0B', danger: '#EF4444',
    card: '#1A1A2E', shadow: 'rgba(0,0,0,0.4)',
  },
};

const COLOR_SCHEMES = {
  indigo:  { primary: '#4F46E5', primaryLight: '#EEF2FF' },
  emerald: { primary: '#059669', primaryLight: '#ECFDF5' },
  rose:    { primary: '#E11D48', primaryLight: '#FFF1F2' },
  amber:   { primary: '#D97706', primaryLight: '#FFFBEB' },
  violet:  { primary: '#7C3AED', primaryLight: '#F5F3FF' },
  sky:     { primary: '#0284C7', primaryLight: '#F0F9FF' },
};

// ─── Offline DB (IndexedDB) ────────────────────────────────────────────────────

class OfflineDB {
  static db = null;
  static async open() {
    if (this.db) return this.db;
    return new Promise((res, rej) => {
      const req = indexedDB.open('SpendWise', 3);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        const stores = {
          expenses:       { keyPath: 'id', indexes: [['user_id','user_id'],['expense_date','expense_date'],['updated_at','updated_at']] },
          categories:     { keyPath: 'id', indexes: [['user_id','user_id']] },
          tags:           { keyPath: 'id', indexes: [['user_id','user_id']] },
          budgets:        { keyPath: 'id', indexes: [['user_id','user_id']] },
          recurring_rules:{ keyPath: 'id', indexes: [['user_id','user_id']] },
          sync_queue:     { keyPath: 'id', indexes: [['created_at','created_at']] },
          settings:       { keyPath: 'key' },
          notifications:  { keyPath: 'id', indexes: [['created_at','created_at']] },
        };
        for (const [name, { keyPath, indexes }] of Object.entries(stores)) {
          if (!db.objectStoreNames.contains(name)) {
            const store = db.createObjectStore(name, { keyPath });
            (indexes || []).forEach(([iName, iKey]) => store.createIndex(iName, iKey));
          }
        }
      };
      req.onsuccess = () => { this.db = req.result; res(req.result); };
      req.onerror = () => rej(req.error);
    });
  }

  static async get(store, key) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const tx = db.transaction(store, 'readonly');
      const req = tx.objectStore(store).get(key);
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
  }

  static async put(store, value) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const tx = db.transaction(store, 'readwrite');
      const req = tx.objectStore(store).put(value);
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
  }

  static async getAll(store, index, range) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const tx = db.transaction(store, 'readonly');
      const s = tx.objectStore(store);
      const req = index ? s.index(index).getAll(range) : s.getAll();
      req.onsuccess = () => res(req.result || []);
      req.onerror = () => rej(req.error);
    });
  }

  static async delete(store, key) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const tx = db.transaction(store, 'readwrite');
      const req = tx.objectStore(store).delete(key);
      req.onsuccess = () => res();
      req.onerror = () => rej(req.error);
    });
  }

  static async count(store) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const tx = db.transaction(store, 'readonly');
      const req = tx.objectStore(store).count();
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
  }
}

// ─── Sync Engine ──────────────────────────────────────────────────────────────

class SyncEngine {
  static BASE_URL = window.SPENDWISE_API || 'http://localhost:8000/api/v1';
  static syncInProgress = false;

  static getToken() { return localStorage.getItem('sw_access_token'); }

  static async fetch(path, opts = {}) {
    const token = this.getToken();
    const res = await fetch(`${this.BASE_URL}${path}`, {
      ...opts,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(opts.headers || {}) },
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    return res.json();
  }

  static async sync() {
    if (this.syncInProgress || !navigator.onLine || !this.getToken()) return;
    this.syncInProgress = true;
    try {
      // Push local mutations
      const queue = await OfflineDB.getAll('sync_queue');
      if (queue.length > 0) {
        const items = queue.map(q => ({
          entity_type: q.entity_type,
          entity_id: q.entity_id,
          operation: q.operation,
          payload: q.payload,
          client_id: q.client_id,
          client_timestamp: q.created_at,
        }));
        const result = await this.fetch('/sync/push', {
          method: 'POST',
          body: JSON.stringify({ device_id: this._deviceId(), items }),
        });
        // Clear pushed items from queue
        for (const q of queue) {
          await OfflineDB.delete('sync_queue', q.id);
        }
      }

      // Pull server changes
      const settings = await OfflineDB.get('settings', 'sync_sequence');
      const since = settings?.value || 0;
      const pullResult = await this.fetch(`/sync/pull?since_sequence=${since}&limit=500`);

      for (const change of pullResult.changes) {
        const store = change.entity_type + 's'; // expense → expenses
        if (change.operation === 'delete') {
          const existing = await OfflineDB.get(store, change.entity_id);
          if (existing) { existing.is_deleted = true; await OfflineDB.put(store, existing); }
        } else {
          await OfflineDB.put(store, { ...change.payload, id: change.entity_id });
        }
      }

      if (pullResult.changes.length > 0) {
        await OfflineDB.put('settings', { key: 'sync_sequence', value: pullResult.server_sequence });
      }
    } catch (e) {
      console.error('[Sync] Failed:', e.message);
    } finally {
      this.syncInProgress = false;
    }
  }

  static async queueMutation(entity_type, entity_id, operation, payload, client_id) {
    await OfflineDB.put('sync_queue', {
      id: `${Date.now()}-${Math.random()}`,
      entity_type, entity_id, operation, payload, client_id,
      created_at: new Date().toISOString(),
    });
    // Attempt immediate sync if online
    if (navigator.onLine) { setTimeout(() => this.sync(), 500); }
  }

  static _deviceId() {
    let id = localStorage.getItem('sw_device_id');
    if (!id) { id = crypto.randomUUID(); localStorage.setItem('sw_device_id', id); }
    return id;
  }
}

// ─── Keyword ML Categorizer (Edge) ───────────────────────────────────────────

const CATEGORY_RULES = {
  'Food & Dining':    ['restaurant','cafe','coffee','pizza','burger','sushi','mcdonald','starbucks','subway','bakery','grill','dining','food'],
  'Groceries':        ['grocery','supermarket','walmart','target','costco','kroger','safeway','whole foods','trader','aldi','market','fresh'],
  'Transportation':   ['uber','lyft','taxi','bus','metro','train','flight','airport','fuel','gas','shell','bp','exxon','parking','toll'],
  'Shopping':         ['amazon','ebay','etsy','mall','store','shop','retail','clothing','fashion','shoes','electronics','best buy','apple'],
  'Healthcare':       ['pharmacy','cvs','walgreens','hospital','clinic','doctor','medical','dental','health','prescription'],
  'Entertainment':    ['netflix','spotify','hulu','disney','cinema','movie','theater','concert','game','steam','arcade'],
  'Utilities':        ['electric','water','internet','broadband','phone','telecom','att','verizon','comcast'],
  'Fitness':          ['gym','fitness','yoga','pilates','crossfit','sport','swimming','peloton'],
  'Travel':           ['hotel','resort','hostel','booking','expedia','airbnb','tour','cruise'],
  'Subscriptions':    ['subscription','membership','monthly','annual','premium','saas'],
};

function edgeCategorize(text) {
  const lower = (text || '').toLowerCase();
  for (const [cat, kws] of Object.entries(CATEGORY_RULES)) {
    const match = kws.find(kw => lower.includes(kw));
    if (match) return { category: cat, confidence: Math.min(0.95, 0.6 + match.length / 20) };
  }
  return null;
}

// ─── App State ────────────────────────────────────────────────────────────────

const initialState = {
  user: null, token: null, expenses: [], categories: [], tags: [],
  budgets: [], notifications: [], isOnline: navigator.onLine,
  syncStatus: 'idle', theme: 'light', colorScheme: 'indigo', fontSize: 'md',
  activeTab: 'dashboard', modalOpen: null, editingExpense: null,
  filters: {}, searchQuery: '', isLoading: false, error: null,
};

function reducer(state, action) {
  switch (action.type) {
    case 'SET_USER':        return { ...state, user: action.payload, token: action.token };
    case 'LOGOUT':          return { ...initialState, theme: state.theme, colorScheme: state.colorScheme };
    case 'SET_EXPENSES':    return { ...state, expenses: action.payload };
    case 'ADD_EXPENSE':     return { ...state, expenses: [action.payload, ...state.expenses] };
    case 'UPDATE_EXPENSE':  return { ...state, expenses: state.expenses.map(e => e.id === action.payload.id ? action.payload : e) };
    case 'DELETE_EXPENSE':  return { ...state, expenses: state.expenses.filter(e => e.id !== action.id) };
    case 'SET_CATEGORIES':  return { ...state, categories: action.payload };
    case 'SET_TAGS':        return { ...state, tags: action.payload };
    case 'SET_BUDGETS':     return { ...state, budgets: action.payload };
    case 'SET_NOTIFICATIONS': return { ...state, notifications: action.payload };
    case 'SET_ONLINE':      return { ...state, isOnline: action.payload };
    case 'SET_SYNC':        return { ...state, syncStatus: action.payload };
    case 'SET_THEME':       return { ...state, theme: action.payload };
    case 'SET_COLOR':       return { ...state, colorScheme: action.payload };
    case 'SET_FONTSIZE':    return { ...state, fontSize: action.payload };
    case 'SET_TAB':         return { ...state, activeTab: action.payload };
    case 'OPEN_MODAL':      return { ...state, modalOpen: action.payload, editingExpense: action.expense || null };
    case 'CLOSE_MODAL':     return { ...state, modalOpen: null, editingExpense: null };
    case 'SET_FILTERS':     return { ...state, filters: { ...state.filters, ...action.payload } };
    case 'SET_SEARCH':      return { ...state, searchQuery: action.payload };
    case 'SET_LOADING':     return { ...state, isLoading: action.payload };
    case 'SET_ERROR':       return { ...state, error: action.payload };
    default:                return state;
  }
}

const AppCtx = createContext(null);
const useApp = () => useContext(AppCtx);

// ─── Hooks ────────────────────────────────────────────────────────────────────

function useTheme() {
  const { state } = useApp();
  const base = THEMES[state.theme];
  const scheme = COLOR_SCHEMES[state.colorScheme];
  return { ...base, ...scheme };
}

function useFontSize() {
  const { state } = useApp();
  const sizes = { sm: 0.875, md: 1, lg: 1.125, xl: 1.25 };
  return sizes[state.fontSize] || 1;
}

// ─── Components ───────────────────────────────────────────────────────────────

const Icon = ({ name, size = 20, color = 'currentColor', style = {} }) => {
  const icons = {
    home: 'M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6',
    plus: 'M12 4v16m8-8H4',
    chart: 'M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z',
    wallet: 'M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z',
    settings: 'M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z M15 12a3 3 0 11-6 0 3 3 0 016 0z',
    bell: 'M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9',
    receipt: 'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2',
    tag: 'M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z',
    calendar: 'M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z',
    cloud: 'M3 15a4 4 0 004 4h9a5 5 0 10-.1-9.999 5.002 5.002 0 10-9.78 2.096A4.001 4.001 0 003 15z',
    check: 'M5 13l4 4L19 7',
    x: 'M6 18L18 6M6 6l12 12',
    edit: 'M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z',
    trash: 'M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16',
    search: 'M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z',
    filter: 'M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z',
    export: 'M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4',
    sync: 'M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15',
    arrow_left: 'M10 19l-7-7m0 0l7-7m-7 7h18',
    trophy: 'M8 21h8m-4-4v4M7 5H5a2 2 0 00-2 2v3c0 4.97 4.03 9 9 9s9-4.03 9-9V7a2 2 0 00-2-2h-2m-4 0V3a2 2 0 00-4 0v2m4 0H8',
    eye: 'M15 12a3 3 0 11-6 0 3 3 0 016 0z M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z',
    info: 'M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z',
    warning: 'M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z',
  };
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color}
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={style} aria-hidden="true">
      {(icons[name] || '').split(' M').map((d, i) => (
        <path key={i} d={i === 0 ? d : 'M' + d} />
      ))}
    </svg>
  );
};

// Category color/icon map
const CAT_COLORS = {
  'Food & Dining': '#F59E0B', 'Groceries': '#10B981', 'Transportation': '#3B82F6',
  'Shopping': '#8B5CF6', 'Healthcare': '#EF4444', 'Entertainment': '#EC4899',
  'Utilities': '#6366F1', 'Housing': '#78716C', 'Education': '#06B6D4',
  'Financial': '#14B8A6', 'Fitness': '#84CC16', 'Travel': '#F97316',
  'Subscriptions': '#A78BFA', 'Other': '#9CA3AF',
};
const CAT_ICONS = {
  'Food & Dining':'🍽️','Groceries':'🛒','Transportation':'🚗','Shopping':'🛍️',
  'Healthcare':'🏥','Entertainment':'🎬','Utilities':'⚡','Housing':'🏠',
  'Education':'📚','Financial':'💳','Fitness':'💪','Travel':'✈️',
  'Subscriptions':'📱','Other':'📌',
};

// ─── App Component ─────────────────────────────────────────────────────────────

export default function SpendWiseApp() {
  const [state, dispatch] = useReducer(reducer, {
    ...initialState,
    theme: localStorage.getItem('sw_theme') || 'light',
    colorScheme: localStorage.getItem('sw_color') || 'indigo',
    fontSize: localStorage.getItem('sw_fontsize') || 'md',
  });

  // Load sample data for demo
  useEffect(() => {
    const sampleExpenses = [
      { id: '1', merchant_name: 'Starbucks', amount: 5.40, currency: 'USD', base_amount: 5.40, category: 'Food & Dining', expense_date: new Date(Date.now() - 86400000).toISOString(), payment_method: 'credit_card', notes: 'Morning coffee', tags: ['work'] },
      { id: '2', merchant_name: 'Uber', amount: 18.90, currency: 'USD', base_amount: 18.90, category: 'Transportation', expense_date: new Date(Date.now() - 172800000).toISOString(), payment_method: 'digital_wallet', notes: 'Airport ride', tags: ['travel'] },
      { id: '3', merchant_name: 'Whole Foods', amount: 127.45, currency: 'USD', base_amount: 127.45, category: 'Groceries', expense_date: new Date(Date.now() - 259200000).toISOString(), payment_method: 'debit_card', notes: 'Weekly shopping', tags: [] },
      { id: '4', merchant_name: 'Netflix', amount: 15.99, currency: 'USD', base_amount: 15.99, category: 'Subscriptions', expense_date: new Date(Date.now() - 345600000).toISOString(), payment_method: 'credit_card', notes: 'Monthly', tags: ['recurring'] },
      { id: '5', merchant_name: 'Planet Fitness', amount: 24.99, currency: 'USD', base_amount: 24.99, category: 'Fitness', expense_date: new Date(Date.now() - 432000000).toISOString(), payment_method: 'credit_card', notes: 'Gym membership', tags: ['health','recurring'] },
      { id: '6', merchant_name: 'Amazon', amount: 89.99, currency: 'USD', base_amount: 89.99, category: 'Shopping', expense_date: new Date(Date.now() - 518400000).toISOString(), payment_method: 'credit_card', notes: 'Headphones', tags: ['online'] },
      { id: '7', merchant_name: 'CVS Pharmacy', amount: 34.20, currency: 'USD', base_amount: 34.20, category: 'Healthcare', expense_date: new Date(Date.now() - 604800000).toISOString(), payment_method: 'debit_card', notes: 'Prescriptions', tags: ['health'] },
      { id: '8', merchant_name: 'Chipotle', amount: 12.75, currency: 'USD', base_amount: 12.75, category: 'Food & Dining', expense_date: new Date(Date.now() - 691200000).toISOString(), payment_method: 'cash', notes: 'Lunch', tags: [] },
    ];
    const sampleCategories = Object.keys(CAT_COLORS).map((name, i) => ({ id: String(i+1), name, icon: CAT_ICONS[name], color: CAT_COLORS[name] }));
    const sampleBudgets = [
      { id: '1', name: 'Monthly Food', amount: 500, currency: 'USD', spent: 143.60, category: 'Food & Dining', period_start: new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString() },
      { id: '2', name: 'Shopping Budget', amount: 200, currency: 'USD', spent: 89.99, category: 'Shopping', period_start: new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString() },
      { id: '3', name: 'Transport', amount: 150, currency: 'USD', spent: 18.90, category: 'Transportation', period_start: new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString() },
    ];
    dispatch({ type: 'SET_EXPENSES', payload: sampleExpenses });
    dispatch({ type: 'SET_CATEGORIES', payload: sampleCategories });
    dispatch({ type: 'SET_BUDGETS', payload: sampleBudgets });
    dispatch({ type: 'SET_USER', payload: { id: 'demo', display_name: 'Alex Morgan', email: 'alex@example.com', base_currency: 'USD', avatar: '👤' }, token: 'demo' });
  }, []);

  // Persist theme
  useEffect(() => { localStorage.setItem('sw_theme', state.theme); }, [state.theme]);
  useEffect(() => { localStorage.setItem('sw_color', state.colorScheme); }, [state.colorScheme]);
  useEffect(() => { localStorage.setItem('sw_fontsize', state.fontSize); }, [state.fontSize]);

  const theme = (() => {
    const base = THEMES[state.theme];
    const scheme = COLOR_SCHEMES[state.colorScheme];
    return { ...base, ...scheme };
  })();

  const fontSize = { sm: 0.875, md: 1, lg: 1.125, xl: 1.25 }[state.fontSize] || 1;

  const ctx = { state, dispatch, theme, fontSize };

  const styles = {
    app: {
      fontFamily: "'DM Sans', -apple-system, BlinkMacSystemFont, sans-serif",
      background: theme.bg,
      color: theme.text,
      minHeight: '100vh',
      maxWidth: 430,
      margin: '0 auto',
      position: 'relative',
      fontSize: `${fontSize}rem`,
      overflowX: 'hidden',
    },
  };

  return (
    <AppCtx.Provider value={ctx}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600;700&family=DM+Mono:wght@400;500&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; -webkit-tap-highlight-color: transparent; }
        ::-webkit-scrollbar { width: 4px; } ::-webkit-scrollbar-thumb { background: ${theme.border}; border-radius: 2px; }
        input, textarea, select { font-family: inherit; color: ${theme.text}; background: ${theme.surfaceAlt}; }
        button { cursor: pointer; font-family: inherit; }
        @keyframes slideUp { from { transform: translateY(20px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
        @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
        @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.5; } }
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        .slide-up { animation: slideUp 0.3s ease; }
        .fade-in { animation: fadeIn 0.2s ease; }
      `}</style>
      <link rel="preconnect" href="https://fonts.googleapis.com" />
      <div style={styles.app} role="main" aria-label="SpendWise App">
        <Header theme={theme} state={state} dispatch={dispatch} />
        <main style={{ paddingBottom: 80, minHeight: 'calc(100vh - 60px)', overflowY: 'auto' }}>
          {state.activeTab === 'dashboard' && <Dashboard />}
          {state.activeTab === 'expenses'  && <ExpenseList />}
          {state.activeTab === 'budgets'   && <BudgetsScreen />}
          {state.activeTab === 'analytics' && <AnalyticsScreen />}
          {state.activeTab === 'settings'  && <SettingsScreen />}
        </main>
        <BottomNav theme={theme} state={state} dispatch={dispatch} />
        {state.modalOpen === 'add_expense' && <ExpenseModal />}
        {state.modalOpen === 'notifications' && <NotificationsPanel />}
        <FAB theme={theme} dispatch={dispatch} />
      </div>
    </AppCtx.Provider>
  );
}

// ─── Header ───────────────────────────────────────────────────────────────────

function Header({ theme, state, dispatch }) {
  const titles = { dashboard: 'SpendWise', expenses: 'Expenses', budgets: 'Budgets', analytics: 'Analytics', settings: 'Settings' };
  return (
    <header style={{
      background: theme.surface, padding: '14px 16px', display: 'flex', alignItems: 'center',
      justifyContent: 'space-between', borderBottom: `1px solid ${theme.border}`,
      position: 'sticky', top: 0, zIndex: 100, backdropFilter: 'blur(10px)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 22, fontWeight: 700, color: theme.primary, letterSpacing: -0.5 }}>
          {state.activeTab === 'dashboard' ? '💸 SpendWise' : titles[state.activeTab]}
        </span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        {/* Sync status */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: '0.7rem', color: state.isOnline ? theme.success : theme.warning }}>
          <div style={{ width: 6, height: 6, borderRadius: '50%', background: state.isOnline ? theme.success : theme.warning }} />
          {state.isOnline ? 'Synced' : 'Offline'}
        </div>
        <button onClick={() => dispatch({ type: 'OPEN_MODAL', payload: 'notifications' })}
          style={{ background: 'none', border: 'none', color: theme.textSub, padding: 4, borderRadius: 8, position: 'relative' }}
          aria-label="Notifications">
          <Icon name="bell" size={20} color={theme.textSub} />
          <span style={{ position: 'absolute', top: 0, right: 0, width: 8, height: 8, background: theme.danger, borderRadius: '50%', border: `2px solid ${theme.surface}` }} />
        </button>
      </div>
    </header>
  );
}

// ─── Bottom Nav ───────────────────────────────────────────────────────────────

function BottomNav({ theme, state, dispatch }) {
  const tabs = [
    { id: 'dashboard', icon: 'home',    label: 'Home'     },
    { id: 'expenses',  icon: 'receipt', label: 'Expenses' },
    { id: 'budgets',   icon: 'wallet',  label: 'Budgets'  },
    { id: 'analytics', icon: 'chart',   label: 'Insights' },
    { id: 'settings',  icon: 'settings',label: 'Settings' },
  ];
  return (
    <nav style={{
      position: 'fixed', bottom: 0, left: '50%', transform: 'translateX(-50%)',
      width: '100%', maxWidth: 430, background: theme.surface,
      borderTop: `1px solid ${theme.border}`, display: 'flex',
      padding: '8px 0 max(8px, env(safe-area-inset-bottom))', zIndex: 100,
    }} aria-label="Main navigation">
      {tabs.map(tab => {
        const active = state.activeTab === tab.id;
        return (
          <button key={tab.id}
            onClick={() => dispatch({ type: 'SET_TAB', payload: tab.id })}
            style={{
              flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3,
              background: 'none', border: 'none', padding: '6px 4px', color: active ? theme.primary : theme.textSub,
              transition: 'color 0.2s', fontSize: '0.65rem', fontWeight: active ? 600 : 400,
            }}
            aria-label={tab.label} aria-current={active ? 'page' : undefined}>
            <div style={{
              padding: 6, borderRadius: 12,
              background: active ? theme.primaryLight : 'transparent', transition: 'all 0.2s',
            }}>
              <Icon name={tab.icon} size={18} color={active ? theme.primary : theme.textSub} />
            </div>
            {tab.label}
          </button>
        );
      })}
    </nav>
  );
}

// ─── FAB ──────────────────────────────────────────────────────────────────────

function FAB({ theme, dispatch }) {
  return (
    <button
      onClick={() => dispatch({ type: 'OPEN_MODAL', payload: 'add_expense' })}
      style={{
        position: 'fixed', bottom: 76, right: 'calc(50% - 215px + 16px)',
        width: 52, height: 52, borderRadius: '50%', background: theme.primary,
        border: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center',
        boxShadow: `0 4px 20px ${theme.primary}60`, zIndex: 99, transition: 'transform 0.15s',
      }}
      aria-label="Add expense"
      onMouseDown={e => e.currentTarget.style.transform = 'scale(0.9)'}
      onMouseUp={e => e.currentTarget.style.transform = 'scale(1)'}
      onTouchStart={e => e.currentTarget.style.transform = 'scale(0.9)'}
      onTouchEnd={e => e.currentTarget.style.transform = 'scale(1)'}>
      <Icon name="plus" size={24} color="white" />
    </button>
  );
}

// ─── Dashboard ────────────────────────────────────────────────────────────────

function Dashboard() {
  const { state, theme, dispatch } = useApp();
  const total = state.expenses.reduce((s, e) => s + (e.base_amount || 0), 0);
  const thisMonth = state.expenses.filter(e => {
    const d = new Date(e.expense_date);
    const now = new Date();
    return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
  });
  const monthTotal = thisMonth.reduce((s, e) => s + (e.base_amount || 0), 0);

  const byCategory = state.expenses.reduce((acc, e) => {
    const cat = e.category || 'Other';
    acc[cat] = (acc[cat] || 0) + (e.base_amount || 0);
    return acc;
  }, {});

  const topCategories = Object.entries(byCategory).sort((a, b) => b[1] - a[1]).slice(0, 5);

  return (
    <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: 16 }} className="fade-in">
      {/* Greeting */}
      <div>
        <p style={{ color: theme.textSub, fontSize: '0.85rem' }}>Good {getTimeOfDay()},</p>
        <h2 style={{ fontSize: '1.4rem', fontWeight: 700, color: theme.text }}>{state.user?.display_name?.split(' ')[0] || 'there'} 👋</h2>
      </div>

      {/* Summary Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <SummaryCard label="This Month" value={`$${monthTotal.toFixed(2)}`} icon="📅" color={theme.primary} theme={theme} />
        <SummaryCard label="All Time" value={`$${total.toFixed(2)}`} icon="💰" color={theme.success} theme={theme} />
        <SummaryCard label="Transactions" value={state.expenses.length} icon="📊" color={theme.warning} theme={theme} />
        <SummaryCard label="Budgets" value={state.budgets.length} icon="🎯" color="#EC4899" theme={theme} />
      </div>

      {/* Budget Overview */}
      {state.budgets.length > 0 && (
        <Card theme={theme}>
          <h3 style={{ fontSize: '0.95rem', fontWeight: 600, marginBottom: 12, color: theme.text }}>Budget Overview</h3>
          {state.budgets.map(budget => {
            const pct = Math.min(100, ((budget.spent || 0) / budget.amount) * 100);
            const color = pct > 90 ? theme.danger : pct > 70 ? theme.warning : theme.success;
            return (
              <div key={budget.id} style={{ marginBottom: 12 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                  <span style={{ fontSize: '0.8rem', fontWeight: 500 }}>{budget.name}</span>
                  <span style={{ fontSize: '0.8rem', color: theme.textSub }}>${(budget.spent || 0).toFixed(0)} / ${budget.amount}</span>
                </div>
                <div style={{ height: 6, background: theme.border, borderRadius: 3, overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${pct}%`, background: color, borderRadius: 3, transition: 'width 0.5s ease' }} />
                </div>
              </div>
            );
          })}
        </Card>
      )}

      {/* Category breakdown */}
      {topCategories.length > 0 && (
        <Card theme={theme}>
          <h3 style={{ fontSize: '0.95rem', fontWeight: 600, marginBottom: 12, color: theme.text }}>Top Categories</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {topCategories.map(([cat, amount]) => {
              const pct = total > 0 ? (amount / total * 100) : 0;
              const color = CAT_COLORS[cat] || '#9CA3AF';
              return (
                <div key={cat} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ fontSize: 20, width: 28, textAlign: 'center' }}>{CAT_ICONS[cat] || '📌'}</span>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
                      <span style={{ fontSize: '0.8rem', fontWeight: 500 }}>{cat}</span>
                      <span style={{ fontSize: '0.8rem', color: theme.textSub }}>${amount.toFixed(2)}</span>
                    </div>
                    <div style={{ height: 4, background: theme.border, borderRadius: 2 }}>
                      <div style={{ height: '100%', width: `${pct}%`, background: color, borderRadius: 2 }} />
                    </div>
                  </div>
                  <span style={{ fontSize: '0.7rem', color: theme.textSub, width: 32, textAlign: 'right' }}>{pct.toFixed(0)}%</span>
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {/* Recent expenses */}
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <h3 style={{ fontSize: '0.95rem', fontWeight: 600 }}>Recent Expenses</h3>
          <button onClick={() => dispatch({ type: 'SET_TAB', payload: 'expenses' })}
            style={{ background: 'none', border: 'none', color: theme.primary, fontSize: '0.8rem', fontWeight: 500 }}>
            View all →
          </button>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {state.expenses.slice(0, 4).map(e => <ExpenseRow key={e.id} expense={e} theme={theme} />)}
        </div>
      </div>
    </div>
  );
}

function SummaryCard({ label, value, icon, color, theme }) {
  return (
    <div style={{
      background: theme.surface, borderRadius: 16, padding: '16px',
      border: `1px solid ${theme.border}`,
      boxShadow: `0 2px 8px ${theme.shadow}`,
    }}>
      <div style={{ fontSize: 24, marginBottom: 8 }}>{icon}</div>
      <div style={{ fontSize: '1.2rem', fontWeight: 700, color }}>{value}</div>
      <div style={{ fontSize: '0.72rem', color: theme.textSub, marginTop: 2 }}>{label}</div>
    </div>
  );
}

function Card({ theme, children, style = {} }) {
  return (
    <div style={{
      background: theme.surface, borderRadius: 16, padding: 16,
      border: `1px solid ${theme.border}`, boxShadow: `0 2px 8px ${theme.shadow}`, ...style,
    }}>
      {children}
    </div>
  );
}

function ExpenseRow({ expense, theme, onEdit, onDelete }) {
  const cat = expense.category || 'Other';
  const color = CAT_COLORS[cat] || '#9CA3AF';
  const icon = CAT_ICONS[cat] || '📌';
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px',
      background: theme.surface, borderRadius: 14, border: `1px solid ${theme.border}`,
    }}>
      <div style={{
        width: 40, height: 40, borderRadius: 12, background: `${color}20`,
        display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20, flexShrink: 0,
      }}>{icon}</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 500, fontSize: '0.9rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {expense.merchant_name || 'Expense'}
        </div>
        <div style={{ fontSize: '0.75rem', color: theme.textSub }}>
          {cat} · {new Date(expense.expense_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
        </div>
      </div>
      <div style={{ fontWeight: 600, color: theme.danger, flexShrink: 0 }}>
        -${expense.amount?.toFixed(2)}
      </div>
      {(onEdit || onDelete) && (
        <div style={{ display: 'flex', gap: 6 }}>
          {onEdit && <button onClick={() => onEdit(expense)} style={{ background: 'none', border: 'none', color: theme.textSub, padding: 4 }}><Icon name="edit" size={15} /></button>}
          {onDelete && <button onClick={() => onDelete(expense.id)} style={{ background: 'none', border: 'none', color: theme.danger, padding: 4 }}><Icon name="trash" size={15} /></button>}
        </div>
      )}
    </div>
  );
}

function getTimeOfDay() {
  const h = new Date().getHours();
  if (h < 12) return 'morning'; if (h < 17) return 'afternoon'; return 'evening';
}

// ─── Expense List ─────────────────────────────────────────────────────────────

function ExpenseList() {
  const { state, dispatch, theme } = useApp();
  const [search, setSearch] = useState('');
  const [filterCat, setFilterCat] = useState('');
  const [showFilters, setShowFilters] = useState(false);

  const filtered = state.expenses.filter(e => {
    const q = search.toLowerCase();
    const matchSearch = !q || (e.merchant_name || '').toLowerCase().includes(q) || (e.notes || '').toLowerCase().includes(q);
    const matchCat = !filterCat || e.category === filterCat;
    return matchSearch && matchCat && !e.is_deleted;
  });

  const grouped = filtered.reduce((acc, e) => {
    const d = new Date(e.expense_date);
    const key = d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
    if (!acc[key]) acc[key] = [];
    acc[key].push(e);
    return acc;
  }, {});

  const handleDelete = (id) => {
    if (window.confirm('Delete this expense?')) dispatch({ type: 'DELETE_EXPENSE', id });
  };

  return (
    <div style={{ padding: 16 }} className="fade-in">
      {/* Search bar */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 12 }}>
        <div style={{
          flex: 1, display: 'flex', alignItems: 'center', gap: 8,
          background: theme.surface, border: `1px solid ${theme.border}`,
          borderRadius: 12, padding: '10px 14px',
        }}>
          <Icon name="search" size={16} color={theme.textSub} />
          <input value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search expenses..." aria-label="Search expenses"
            style={{ border: 'none', outline: 'none', flex: 1, background: 'transparent', fontSize: '0.9rem' }} />
        </div>
        <button onClick={() => setShowFilters(!showFilters)}
          style={{
            background: showFilters ? theme.primaryLight : theme.surface,
            border: `1px solid ${showFilters ? theme.primary : theme.border}`,
            borderRadius: 12, padding: '10px 14px', color: showFilters ? theme.primary : theme.textSub,
          }} aria-label="Toggle filters">
          <Icon name="filter" size={18} color={showFilters ? theme.primary : theme.textSub} />
        </button>
      </div>

      {/* Filter chips */}
      {showFilters && (
        <div style={{ display: 'flex', gap: 8, overflowX: 'auto', marginBottom: 12, paddingBottom: 4 }}>
          <FilterChip label="All" active={!filterCat} onClick={() => setFilterCat('')} theme={theme} />
          {Object.keys(CAT_COLORS).map(c => (
            <FilterChip key={c} label={`${CAT_ICONS[c]} ${c}`} active={filterCat === c} onClick={() => setFilterCat(c)} theme={theme} />
          ))}
        </div>
      )}

      {/* Grouped list */}
      {Object.entries(grouped).length === 0 ? (
        <EmptyState icon="receipt" message="No expenses found" sub="Tap + to add your first expense" theme={theme} />
      ) : (
        Object.entries(grouped).map(([date, expenses]) => (
          <div key={date} style={{ marginBottom: 20 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
              <span style={{ fontSize: '0.78rem', fontWeight: 600, color: theme.textSub, textTransform: 'uppercase', letterSpacing: 0.5 }}>{date}</span>
              <span style={{ fontSize: '0.78rem', color: theme.textSub }}>${expenses.reduce((s,e) => s + e.amount, 0).toFixed(2)}</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {expenses.map(e => (
                <ExpenseRow key={e.id} expense={e} theme={theme}
                  onEdit={(exp) => dispatch({ type: 'OPEN_MODAL', payload: 'add_expense', expense: exp })}
                  onDelete={handleDelete} />
              ))}
            </div>
          </div>
        ))
      )}
    </div>
  );
}

function FilterChip({ label, active, onClick, theme }) {
  return (
    <button onClick={onClick} style={{
      whiteSpace: 'nowrap', padding: '6px 12px', borderRadius: 20, fontSize: '0.78rem',
      background: active ? theme.primary : theme.surface,
      color: active ? 'white' : theme.textSub,
      border: `1px solid ${active ? theme.primary : theme.border}`,
      fontWeight: active ? 600 : 400, transition: 'all 0.15s',
    }}>{label}</button>
  );
}

function EmptyState({ icon, message, sub, theme }) {
  return (
    <div style={{ textAlign: 'center', padding: '48px 24px', color: theme.textSub }}>
      <div style={{ fontSize: 48, marginBottom: 12 }}>💸</div>
      <div style={{ fontWeight: 600, color: theme.text, marginBottom: 6 }}>{message}</div>
      <div style={{ fontSize: '0.85rem' }}>{sub}</div>
    </div>
  );
}

// ─── Expense Modal ────────────────────────────────────────────────────────────

function ExpenseModal() {
  const { state, dispatch, theme } = useApp();
  const editing = state.editingExpense;
  const [form, setForm] = useState({
    amount: editing?.amount || '',
    currency: editing?.currency || 'USD',
    merchant_name: editing?.merchant_name || '',
    category: editing?.category || '',
    notes: editing?.notes || '',
    payment_method: editing?.payment_method || 'credit_card',
    expense_date: editing?.expense_date ? new Date(editing.expense_date).toISOString().slice(0, 16) : new Date().toISOString().slice(0, 16),
    location_name: editing?.location_name || '',
    tags: editing?.tags || [],
  });
  const [mlSuggestion, setMlSuggestion] = useState(null);
  const [saving, setSaving] = useState(false);
  const [activeTab, setActiveTab] = useState('basic');

  // Edge ML suggestion when merchant changes
  useEffect(() => {
    if (form.merchant_name.length > 2 && !form.category) {
      const result = edgeCategorize(form.merchant_name + ' ' + form.notes);
      if (result) setMlSuggestion(result);
    }
  }, [form.merchant_name, form.notes]);

  const handleSave = async () => {
    if (!form.amount || isNaN(parseFloat(form.amount))) return;
    setSaving(true);
    const expense = {
      id: editing?.id || crypto.randomUUID(),
      ...form,
      amount: parseFloat(form.amount),
      base_amount: parseFloat(form.amount),
      expense_date: new Date(form.expense_date).toISOString(),
      category: form.category || mlSuggestion?.category || 'Other',
      is_deleted: false,
    };
    if (editing) {
      dispatch({ type: 'UPDATE_EXPENSE', payload: expense });
    } else {
      dispatch({ type: 'ADD_EXPENSE', payload: expense });
    }
    await OfflineDB.put('expenses', expense);
    await SyncEngine.queueMutation('expense', expense.id, editing ? 'update' : 'create', expense, expense.id);
    setSaving(false);
    dispatch({ type: 'CLOSE_MODAL' });
  };

  const currencies = ['USD', 'EUR', 'GBP', 'JPY', 'CAD', 'AUD', 'INR', 'SGD', 'CHF', 'CNY'];
  const methods = ['credit_card', 'debit_card', 'cash', 'digital_wallet', 'bank_transfer'];
  const methodLabels = { credit_card: '💳 Credit Card', debit_card: '🏦 Debit Card', cash: '💵 Cash', digital_wallet: '📱 Digital Wallet', bank_transfer: '🏛️ Bank Transfer' };

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 200, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end',
    }}>
      <div onClick={() => dispatch({ type: 'CLOSE_MODAL' })}
        style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.5)' }} />
      <div style={{
        position: 'relative', background: theme.surface, borderRadius: '24px 24px 0 0',
        padding: '0 0 max(24px, env(safe-area-inset-bottom))',
        maxHeight: '92vh', overflow: 'hidden', display: 'flex', flexDirection: 'column',
      }} className="slide-up">
        {/* Handle */}
        <div style={{ width: 40, height: 4, background: theme.border, borderRadius: 2, margin: '12px auto 0' }} />
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 20px 16px' }}>
          <h2 style={{ fontWeight: 700, fontSize: '1.1rem' }}>{editing ? 'Edit Expense' : 'Add Expense'}</h2>
          <button onClick={() => dispatch({ type: 'CLOSE_MODAL' })}
            style={{ background: theme.surfaceAlt, border: 'none', borderRadius: 20, padding: '6px 10px', color: theme.textSub }}>
            <Icon name="x" size={16} />
          </button>
        </div>

        {/* Tab pills */}
        <div style={{ display: 'flex', gap: 8, padding: '0 20px 16px' }}>
          {['basic', 'details', 'split'].map(t => (
            <button key={t} onClick={() => setActiveTab(t)} style={{
              padding: '6px 16px', borderRadius: 20, border: 'none', fontSize: '0.8rem',
              background: activeTab === t ? theme.primary : theme.surfaceAlt,
              color: activeTab === t ? 'white' : theme.textSub, fontWeight: 500,
            }}>{t.charAt(0).toUpperCase() + t.slice(1)}</button>
          ))}
        </div>

        <div style={{ overflowY: 'auto', padding: '0 20px', flex: 1 }}>
          {activeTab === 'basic' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              {/* Amount */}
              <div>
                <label style={{ fontSize: '0.78rem', fontWeight: 600, color: theme.textSub, marginBottom: 6, display: 'block' }}>AMOUNT *</label>
                <div style={{ display: 'flex', gap: 8 }}>
                  <select value={form.currency} onChange={e => setForm(f => ({...f, currency: e.target.value}))}
                    style={{ border: `1px solid ${theme.border}`, borderRadius: 12, padding: '12px 10px', background: theme.surfaceAlt, fontSize: '0.9rem' }}>
                    {currencies.map(c => <option key={c}>{c}</option>)}
                  </select>
                  <input type="number" placeholder="0.00" value={form.amount}
                    onChange={e => setForm(f => ({...f, amount: e.target.value}))}
                    style={{
                      flex: 1, border: `1px solid ${theme.border}`, borderRadius: 12, padding: '12px 14px',
                      fontSize: '1.4rem', fontWeight: 700, background: theme.surfaceAlt, outline: 'none',
                    }} aria-label="Expense amount" inputMode="decimal" />
                </div>
              </div>

              {/* Merchant */}
              <FormField label="MERCHANT / STORE" placeholder="e.g. Starbucks, Amazon..." value={form.merchant_name}
                onChange={v => setForm(f => ({...f, merchant_name: v}))} theme={theme} />

              {/* ML Suggestion */}
              {mlSuggestion && !form.category && (
                <div style={{ background: theme.primaryLight, borderRadius: 12, padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ fontSize: 18 }}>🤖</span>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: '0.78rem', color: theme.primary, fontWeight: 600 }}>Suggested category</div>
                    <div style={{ fontSize: '0.85rem', fontWeight: 500 }}>{mlSuggestion.category} ({Math.round(mlSuggestion.confidence * 100)}% confident)</div>
                  </div>
                  <button onClick={() => setForm(f => ({...f, category: mlSuggestion.category}))}
                    style={{ background: theme.primary, color: 'white', border: 'none', borderRadius: 8, padding: '6px 12px', fontSize: '0.78rem', fontWeight: 600 }}>
                    Use
                  </button>
                </div>
              )}

              {/* Category */}
              <div>
                <label style={{ fontSize: '0.78rem', fontWeight: 600, color: theme.textSub, marginBottom: 6, display: 'block' }}>CATEGORY</label>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  {Object.keys(CAT_COLORS).map(cat => (
                    <button key={cat} onClick={() => setForm(f => ({...f, category: f.category === cat ? '' : cat}))}
                      style={{
                        padding: '6px 12px', borderRadius: 20, border: `1px solid ${form.category === cat ? CAT_COLORS[cat] : theme.border}`,
                        background: form.category === cat ? `${CAT_COLORS[cat]}20` : theme.surfaceAlt,
                        color: form.category === cat ? CAT_COLORS[cat] : theme.textSub,
                        fontSize: '0.78rem', fontWeight: form.category === cat ? 600 : 400,
                      }}>
                      {CAT_ICONS[cat]} {cat}
                    </button>
                  ))}
                </div>
              </div>

              {/* Date */}
              <div>
                <label style={{ fontSize: '0.78rem', fontWeight: 600, color: theme.textSub, marginBottom: 6, display: 'block' }}>DATE & TIME</label>
                <input type="datetime-local" value={form.expense_date}
                  onChange={e => setForm(f => ({...f, expense_date: e.target.value}))}
                  style={{ width: '100%', border: `1px solid ${theme.border}`, borderRadius: 12, padding: '12px 14px', background: theme.surfaceAlt, fontSize: '0.9rem', outline: 'none' }} />
              </div>
            </div>
          )}

          {activeTab === 'details' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              {/* Payment Method */}
              <div>
                <label style={{ fontSize: '0.78rem', fontWeight: 600, color: theme.textSub, marginBottom: 6, display: 'block' }}>PAYMENT METHOD</label>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {methods.map(m => (
                    <button key={m} onClick={() => setForm(f => ({...f, payment_method: m}))}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px',
                        border: `1px solid ${form.payment_method === m ? theme.primary : theme.border}`,
                        borderRadius: 12, background: form.payment_method === m ? theme.primaryLight : theme.surfaceAlt,
                        color: form.payment_method === m ? theme.primary : theme.text,
                        fontWeight: form.payment_method === m ? 600 : 400, fontSize: '0.9rem',
                      }}>
                      <span>{methodLabels[m]}</span>
                      {form.payment_method === m && <Icon name="check" size={16} color={theme.primary} style={{ marginLeft: 'auto' }} />}
                    </button>
                  ))}
                </div>
              </div>

              <FormField label="LOCATION" placeholder="e.g. New York, NY" value={form.location_name}
                onChange={v => setForm(f => ({...f, location_name: v}))} theme={theme} />

              <div>
                <label style={{ fontSize: '0.78rem', fontWeight: 600, color: theme.textSub, marginBottom: 6, display: 'block' }}>NOTES</label>
                <textarea value={form.notes} onChange={e => setForm(f => ({...f, notes: e.target.value}))}
                  placeholder="Add notes..." rows={3}
                  style={{ width: '100%', border: `1px solid ${theme.border}`, borderRadius: 12, padding: '12px 14px', background: theme.surfaceAlt, fontSize: '0.9rem', outline: 'none', resize: 'vertical' }} />
              </div>
            </div>
          )}

          {activeTab === 'split' && (
            <div style={{ textAlign: 'center', padding: '32px 0', color: theme.textSub }}>
              <div style={{ fontSize: 48, marginBottom: 12 }}>👥</div>
              <div style={{ fontWeight: 600, color: theme.text }}>Expense Splitting</div>
              <div style={{ fontSize: '0.85rem', marginTop: 8 }}>Add wallet members to split this expense</div>
              <button style={{
                marginTop: 20, padding: '12px 24px', background: theme.primaryLight,
                color: theme.primary, border: `1px solid ${theme.primary}`,
                borderRadius: 12, fontWeight: 600,
              }}>Add Split</button>
            </div>
          )}
        </div>

        {/* Save button */}
        <div style={{ padding: '16px 20px 0' }}>
          <button onClick={handleSave} disabled={saving || !form.amount}
            style={{
              width: '100%', padding: '16px', background: form.amount ? theme.primary : theme.border,
              color: 'white', border: 'none', borderRadius: 16, fontSize: '1rem',
              fontWeight: 700, transition: 'all 0.15s', opacity: saving ? 0.7 : 1,
            }}>
            {saving ? '⏳ Saving...' : editing ? '✓ Update Expense' : '+ Add Expense'}
          </button>
        </div>
      </div>
    </div>
  );
}

function FormField({ label, placeholder, value, onChange, theme, type = 'text' }) {
  return (
    <div>
      <label style={{ fontSize: '0.78rem', fontWeight: 600, color: theme.textSub, marginBottom: 6, display: 'block' }}>{label}</label>
      <input type={type} placeholder={placeholder} value={value} onChange={e => onChange(e.target.value)}
        style={{ width: '100%', border: `1px solid ${theme.border}`, borderRadius: 12, padding: '12px 14px', background: theme.surfaceAlt, fontSize: '0.9rem', outline: 'none' }} />
    </div>
  );
}

// ─── Budgets Screen ───────────────────────────────────────────────────────────

function BudgetsScreen() {
  const { state, theme } = useApp();
  return (
    <div style={{ padding: 16 }} className="fade-in">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h2 style={{ fontWeight: 700 }}>Your Budgets</h2>
        <button style={{ background: theme.primary, color: 'white', border: 'none', borderRadius: 12, padding: '8px 16px', fontSize: '0.85rem', fontWeight: 600 }}>+ New</button>
      </div>
      {state.budgets.map(budget => {
        const pct = Math.min(100, ((budget.spent || 0) / budget.amount) * 100);
        const color = pct > 90 ? theme.danger : pct > 70 ? theme.warning : theme.success;
        const remaining = budget.amount - (budget.spent || 0);
        return (
          <div key={budget.id} style={{ background: theme.surface, borderRadius: 16, padding: 16, marginBottom: 12, border: `1px solid ${theme.border}` }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12 }}>
              <div>
                <div style={{ fontWeight: 600 }}>{budget.name}</div>
                <div style={{ fontSize: '0.78rem', color: theme.textSub }}>{budget.category}</div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontWeight: 700, color }}>{pct.toFixed(0)}%</div>
                <div style={{ fontSize: '0.75rem', color: theme.textSub }}>used</div>
              </div>
            </div>
            <div style={{ height: 8, background: theme.border, borderRadius: 4, overflow: 'hidden', marginBottom: 10 }}>
              <div style={{ height: '100%', width: `${pct}%`, background: color, borderRadius: 4, transition: 'width 0.5s' }} />
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem' }}>
              <span style={{ color: theme.textSub }}>Spent: <strong style={{ color: theme.text }}>${(budget.spent || 0).toFixed(2)}</strong></span>
              <span style={{ color: theme.textSub }}>Left: <strong style={{ color: remaining >= 0 ? theme.success : theme.danger }}>${Math.abs(remaining).toFixed(2)}{remaining < 0 ? ' over' : ''}</strong></span>
              <span style={{ color: theme.textSub }}>Limit: <strong style={{ color: theme.text }}>${budget.amount}</strong></span>
            </div>
          </div>
        );
      })}
      {state.budgets.length === 0 && <EmptyState icon="wallet" message="No budgets yet" sub="Create a budget to track spending" theme={theme} />}
    </div>
  );
}

// ─── Analytics Screen ─────────────────────────────────────────────────────────

function AnalyticsScreen() {
  const { state, theme } = useApp();
  const byCategory = state.expenses.reduce((acc, e) => {
    const cat = e.category || 'Other';
    acc[cat] = (acc[cat] || 0) + (e.base_amount || 0);
    return acc;
  }, {});
  const total = Object.values(byCategory).reduce((s, v) => s + v, 0);
  const sorted = Object.entries(byCategory).sort((a, b) => b[1] - a[1]);

  // Weekly data (last 7 days)
  const weekData = Array.from({length: 7}, (_, i) => {
    const d = new Date(); d.setDate(d.getDate() - (6 - i));
    const dayStr = d.toLocaleDateString('en-US', { weekday: 'short' });
    const dayTotal = state.expenses.filter(e => {
      const ed = new Date(e.expense_date);
      return ed.getDate() === d.getDate() && ed.getMonth() === d.getMonth();
    }).reduce((s, e) => s + e.base_amount, 0);
    return { label: dayStr, value: dayTotal };
  });
  const maxDay = Math.max(...weekData.map(d => d.value), 1);

  return (
    <div style={{ padding: 16 }} className="fade-in">
      <h2 style={{ fontWeight: 700, marginBottom: 16 }}>Spending Insights</h2>

      {/* Weekly bar chart */}
      <Card theme={theme} style={{ marginBottom: 16 }}>
        <h3 style={{ fontSize: '0.95rem', fontWeight: 600, marginBottom: 14 }}>Last 7 Days</h3>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, height: 100 }}>
          {weekData.map((d, i) => (
            <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
              <div style={{
                width: '100%', height: `${(d.value / maxDay) * 80}px`, minHeight: d.value > 0 ? 4 : 0,
                background: d.value > 0 ? theme.primary : theme.border,
                borderRadius: 4, transition: 'height 0.4s ease',
              }} />
              <span style={{ fontSize: '0.65rem', color: theme.textSub }}>{d.label}</span>
              {d.value > 0 && <span style={{ fontSize: '0.6rem', color: theme.primary, fontWeight: 600 }}>${d.value.toFixed(0)}</span>}
            </div>
          ))}
        </div>
      </Card>

      {/* Donut/pie */}
      <Card theme={theme} style={{ marginBottom: 16 }}>
        <h3 style={{ fontSize: '0.95rem', fontWeight: 600, marginBottom: 14 }}>Category Breakdown</h3>
        <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
          {/* Simple visual donut */}
          <div style={{ position: 'relative', width: 100, height: 100, flexShrink: 0 }}>
            <svg viewBox="0 0 36 36" style={{ width: 100, height: 100, transform: 'rotate(-90deg)' }}>
              {(() => {
                let offset = 0;
                return sorted.slice(0, 6).map(([cat, val], i) => {
                  const pct = (val / total) * 100;
                  const color = CAT_COLORS[cat] || '#9CA3AF';
                  const el = (
                    <circle key={cat} r="15.9155" cx="18" cy="18" fill="none"
                      stroke={color} strokeWidth="3.5"
                      strokeDasharray={`${pct} ${100 - pct}`}
                      strokeDashoffset={-offset} />
                  );
                  offset += pct;
                  return el;
                });
              })()}
            </svg>
            <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
              <span style={{ fontSize: '0.7rem', color: theme.textSub }}>Total</span>
              <span style={{ fontSize: '0.85rem', fontWeight: 700 }}>${total.toFixed(0)}</span>
            </div>
          </div>
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {sorted.slice(0, 5).map(([cat, val]) => (
              <div key={cat} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{ width: 10, height: 10, borderRadius: 2, background: CAT_COLORS[cat] || '#9CA3AF', flexShrink: 0 }} />
                <span style={{ fontSize: '0.75rem', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{cat}</span>
                <span style={{ fontSize: '0.72rem', color: theme.textSub, fontWeight: 600 }}>{total > 0 ? ((val/total)*100).toFixed(0) : 0}%</span>
              </div>
            ))}
          </div>
        </div>
      </Card>

      {/* Anomaly insight */}
      <div style={{ background: `${theme.warning}15`, border: `1px solid ${theme.warning}40`, borderRadius: 16, padding: 14, marginBottom: 16, display: 'flex', gap: 12, alignItems: 'flex-start' }}>
        <span style={{ fontSize: 20 }}>💡</span>
        <div>
          <div style={{ fontWeight: 600, fontSize: '0.9rem', marginBottom: 4 }}>Spending Insight</div>
          <div style={{ fontSize: '0.8rem', color: theme.textSub }}>
            Your Food & Dining spending is 28% higher than last month. Consider setting a budget limit.
          </div>
        </div>
      </div>

      {/* Top merchants */}
      <Card theme={theme}>
        <h3 style={{ fontSize: '0.95rem', fontWeight: 600, marginBottom: 12 }}>Top Merchants</h3>
        {Object.entries(
          state.expenses.reduce((acc, e) => {
            const m = e.merchant_name || 'Unknown';
            acc[m] = (acc[m] || 0) + e.amount;
            return acc;
          }, {})
        ).sort((a,b) => b[1]-a[1]).slice(0,5).map(([m, v]) => (
          <div key={m} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: `1px solid ${theme.border}` }}>
            <span style={{ fontSize: '0.85rem' }}>{m}</span>
            <span style={{ fontSize: '0.85rem', fontWeight: 600 }}>${v.toFixed(2)}</span>
          </div>
        ))}
      </Card>
    </div>
  );
}

// ─── Settings Screen ──────────────────────────────────────────────────────────

function SettingsScreen() {
  const { state, dispatch, theme } = useApp();
  return (
    <div style={{ padding: 16 }} className="fade-in">
      <h2 style={{ fontWeight: 700, marginBottom: 20 }}>Settings</h2>

      <SettingsSection title="APPEARANCE" theme={theme}>
        {/* Theme toggle */}
        <SettingsRow label="Theme" theme={theme}>
          <div style={{ display: 'flex', gap: 8 }}>
            {['light', 'dark'].map(t => (
              <button key={t} onClick={() => dispatch({ type: 'SET_THEME', payload: t })}
                style={{
                  padding: '6px 14px', borderRadius: 20, border: `1px solid ${state.theme === t ? theme.primary : theme.border}`,
                  background: state.theme === t ? theme.primary : theme.surfaceAlt,
                  color: state.theme === t ? 'white' : theme.textSub, fontSize: '0.8rem', fontWeight: 500,
                }}>{t === 'light' ? '☀️ Light' : '🌙 Dark'}</button>
            ))}
          </div>
        </SettingsRow>

        {/* Color scheme */}
        <SettingsRow label="Color Scheme" theme={theme}>
          <div style={{ display: 'flex', gap: 10 }}>
            {Object.entries(COLOR_SCHEMES).map(([name, scheme]) => (
              <button key={name} onClick={() => dispatch({ type: 'SET_COLOR', payload: name })}
                style={{
                  width: 28, height: 28, borderRadius: '50%', background: scheme.primary,
                  border: state.colorScheme === name ? `3px solid ${theme.text}` : `2px solid transparent`,
                  cursor: 'pointer', transition: 'border 0.2s',
                }} aria-label={`${name} color scheme`} />
            ))}
          </div>
        </SettingsRow>

        {/* Font size */}
        <SettingsRow label="Text Size" theme={theme}>
          <div style={{ display: 'flex', gap: 6 }}>
            {['sm', 'md', 'lg', 'xl'].map(s => (
              <button key={s} onClick={() => dispatch({ type: 'SET_FONTSIZE', payload: s })}
                style={{
                  width: 36, height: 36, borderRadius: 8, border: `1px solid ${state.fontSize === s ? theme.primary : theme.border}`,
                  background: state.fontSize === s ? theme.primaryLight : theme.surfaceAlt,
                  color: state.fontSize === s ? theme.primary : theme.textSub,
                  fontSize: { sm: '0.7rem', md: '0.85rem', lg: '1rem', xl: '1.1rem' }[s], fontWeight: 600,
                }}>A</button>
            ))}
          </div>
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="ACCOUNT" theme={theme}>
        <SettingsRow label="Name" value={state.user?.display_name} theme={theme} />
        <SettingsRow label="Email" value={state.user?.email} theme={theme} />
        <SettingsRow label="Base Currency" value={state.user?.base_currency} theme={theme} />
      </SettingsSection>

      <SettingsSection title="PRIVACY & SECURITY" theme={theme}>
        <SettingsRow label="Offline Backup" theme={theme}>
          <span style={{ fontSize: '0.8rem', color: theme.success }}>✓ Encrypted</span>
        </SettingsRow>
        <SettingsRow label="Data Collection" theme={theme}>
          <span style={{ fontSize: '0.8rem', color: theme.textSub }}>GDPR Compliant</span>
        </SettingsRow>
        <SettingsRow label="Cloud Sync" theme={theme}>
          <div style={{ width: 44, height: 24, background: theme.success, borderRadius: 12, position: 'relative', cursor: 'pointer' }}>
            <div style={{ width: 18, height: 18, background: 'white', borderRadius: '50%', position: 'absolute', right: 3, top: 3 }} />
          </div>
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="DATA" theme={theme}>
        <SettingsRow label="Export CSV" theme={theme}>
          <button style={{ background: 'none', border: 'none', color: theme.primary, fontSize: '0.85rem', fontWeight: 600 }}>Export →</button>
        </SettingsRow>
        <SettingsRow label="Export PDF" theme={theme}>
          <button style={{ background: 'none', border: 'none', color: theme.primary, fontSize: '0.85rem', fontWeight: 600 }}>Export →</button>
        </SettingsRow>
      </SettingsSection>

      <div style={{ padding: '16px 0', textAlign: 'center' }}>
        <div style={{ fontSize: '0.72rem', color: theme.textSub, marginBottom: 16 }}>
          SpendWise v1.0.0 · No banking credentials stored<br />
          GDPR & DPDP Compliant · AES-256 encrypted
        </div>
        <button onClick={() => dispatch({ type: 'LOGOUT' })}
          style={{ color: theme.danger, background: 'none', border: `1px solid ${theme.danger}`, borderRadius: 12, padding: '10px 24px', fontWeight: 600 }}>
          Sign Out
        </button>
      </div>
    </div>
  );
}

function SettingsSection({ title, children, theme }) {
  return (
    <div style={{ marginBottom: 24 }}>
      <div style={{ fontSize: '0.7rem', fontWeight: 700, color: theme.textSub, letterSpacing: 1, marginBottom: 10, textTransform: 'uppercase' }}>{title}</div>
      <div style={{ background: theme.surface, borderRadius: 16, border: `1px solid ${theme.border}`, overflow: 'hidden' }}>
        {children}
      </div>
    </div>
  );
}

function SettingsRow({ label, value, children, theme }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 16px', borderBottom: `1px solid ${theme.border}` }}>
      <span style={{ fontSize: '0.9rem' }}>{label}</span>
      {children || <span style={{ fontSize: '0.85rem', color: theme.textSub }}>{value}</span>}
    </div>
  );
}

// ─── Notifications Panel ──────────────────────────────────────────────────────

function NotificationsPanel() {
  const { dispatch, theme } = useApp();
  const sample = [
    { id: 1, icon: '⚠️', title: 'Budget Alert', body: "You've used 80% of your Food budget", time: '2m ago', type: 'warning' },
    { id: 2, icon: '🔁', title: 'Recurring Due', body: 'Netflix subscription is due today', time: '1h ago', type: 'info' },
    { id: 3, icon: '📊', title: 'Weekly Summary', body: 'You spent $334.52 this week', time: '2d ago', type: 'success' },
  ];
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 200, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
      <div onClick={() => dispatch({ type: 'CLOSE_MODAL' })} style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.5)' }} />
      <div style={{ position: 'relative', background: theme.surface, borderRadius: '24px 24px 0 0', maxHeight: '75vh', overflow: 'hidden', display: 'flex', flexDirection: 'column' }} className="slide-up">
        <div style={{ width: 40, height: 4, background: theme.border, borderRadius: 2, margin: '12px auto 0' }} />
        <div style={{ display: 'flex', justifyContent: 'space-between', padding: '12px 20px 16px', alignItems: 'center' }}>
          <h2 style={{ fontWeight: 700 }}>Notifications</h2>
          <button onClick={() => dispatch({ type: 'CLOSE_MODAL' })} style={{ background: 'none', border: 'none', color: theme.primary, fontWeight: 600 }}>Mark all read</button>
        </div>
        <div style={{ overflowY: 'auto', padding: '0 16px 24px' }}>
          {sample.map(n => (
            <div key={n.id} style={{ display: 'flex', gap: 14, padding: '14px', background: theme.surfaceAlt, borderRadius: 14, marginBottom: 10 }}>
              <span style={{ fontSize: 24 }}>{n.icon}</span>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600, fontSize: '0.9rem' }}>{n.title}</div>
                <div style={{ fontSize: '0.8rem', color: theme.textSub, marginTop: 2 }}>{n.body}</div>
                <div style={{ fontSize: '0.72rem', color: theme.textSub, marginTop: 6 }}>{n.time}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
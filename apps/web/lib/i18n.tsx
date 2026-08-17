'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useSyncExternalStore } from 'react';

export type Language = 'en' | 'ja';

type MessageParams = Record<string, string | number>;

const LANGUAGE_STORAGE_KEY = 'openmemory-language';

function getStoredLanguage(): Language {
  if (typeof window === 'undefined') return 'en';
  const stored = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
  return stored === 'ja' ? 'ja' : 'en';
}

function subscribeToLanguage(onChange: () => void): () => void {
  window.addEventListener('openmemory-language-change', onChange);
  window.addEventListener('storage', onChange);
  return () => {
    window.removeEventListener('openmemory-language-change', onChange);
    window.removeEventListener('storage', onChange);
  };
}

const getServerLanguage = (): Language => 'en';

const MESSAGES: Record<Language, Record<string, string>> = {
  en: {
    'nav.workspace': 'Workspace',
    'nav.memory': 'Memory',
    'nav.projects': 'Projects',
    'nav.agents': 'Agents',
    'nav.settings': 'Settings',
    'nav.dashboard': 'Dashboard',
    'nav.dashboard.description': 'Open the app launcher',
    'nav.memory.browse': 'Browse',
    'nav.memory.browse.description': 'View saved memories',
    'nav.memory.search': 'Search',
    'nav.memory.search.description': 'Find stored context',
    'nav.memory.graph': 'Graph',
    'nav.memory.graph.description': 'Explore connections',
    'nav.projects.list': 'List',
    'nav.projects.list.description': 'Browse projects',
    'nav.projects.board': 'Board',
    'nav.projects.board.description': 'Track work by status',
    'nav.projects.roadmap': 'Roadmap',
    'nav.projects.roadmap.description': 'Plan on a timeline',
    'nav.projects.lessons': 'Lessons',
    'nav.projects.lessons.description': 'Review learned patterns',
    'nav.projects.library': 'Library',
    'nav.projects.library.description': 'Browse visual assets',
    'nav.agents.agents': 'Agents',
    'nav.agents.agents.description': 'Configure agents',
    'nav.agents.sessions': 'Sessions',
    'nav.agents.sessions.description': 'Review activity',
    'nav.agents.usage': 'Usage',
    'nav.agents.usage.description': 'Inspect consumption',
    'nav.settings.llm': 'LLM',
    'nav.settings.llm.description': 'Model configuration',
    'nav.settings.forecasts': 'Forecasts',
    'nav.settings.forecasts.description': 'Usage projections',
    'nav.settings.environment': 'Environment',
    'nav.settings.environment.description': 'Runtime variables',
    'nav.settings.resources': 'Resources',
    'nav.settings.resources.description': 'Connected resources',
    'nav.settings.workflows': 'Workflows',
    'nav.settings.workflows.description': 'Automated routines',
    'header.openNavigation': 'Open navigation menu',
    'header.services': 'OpenMemory services',
    'header.chooseWorkspace': 'Choose a workspace to continue',
    'header.navigation': 'Navigation',
    'header.console': 'Console',
    'header.overview': 'Overview',
    'header.switchToLight': 'Switch to light mode',
    'header.switchToDark': 'Switch to dark mode',
    'header.preferences': 'Open display and language settings',
    'settings.appearance': 'Appearance',
    'settings.theme': 'Theme',
    'settings.theme.light': 'Light',
    'settings.theme.dark': 'Dark',
    'settings.theme.system': 'System',
    'settings.language': 'Language',
    'language.english': 'English',
    'language.japanese': 'Japanese',
    'dashboard.eyebrow': 'Workspace / App launcher',
    'dashboard.description': 'Your memory operations workspace. Choose an app to browse context, coordinate agents, and shape project knowledge.',
    'dashboard.appsAvailable': '{count} apps available',
    'page.projects': 'Projects',
    'page.agents': 'Agents',
    'page.sessions': 'Sessions',
    'page.agentUsage': 'Agent Usage',
    'page.memory': 'Memory',
    'page.search': 'Search',
    'page.settings': 'Settings',
    'page.environment': 'Environment',
    'page.resources': 'Resources',
    'page.workflows': 'Workflows',
    'page.forecasts': 'Forecasts',
    'page.lessons': 'Lessons',
    'page.library': 'Library',
    'page.roadmap': 'Roadmap',
    'page.taskDetail': 'Task Detail',
    'projects.refresh': 'Refresh',
    'projects.project': 'Project',
    'projects.allProjects': 'All Projects',
    'projects.searchBoard': 'Search tasks and routines...',
    'projects.task': 'Task',
    'projects.noProjects': 'No projects yet.',
    'projects.createHint': 'Click "+ Project" to create one.',
    'projects.newProject': 'New Project',
    'projects.newTask': 'New Task',
    'projects.cancel': 'Cancel',
    'projects.close': 'Close',
    'status.scheduled': 'Scheduled',
    'status.todo': 'Todo',
    'status.in_progress': 'In Progress',
    'status.done': 'Done',
    'status.cancelled': 'Cancelled',
  },
  ja: {
    'nav.workspace': 'ワークスペース',
    'nav.memory': 'メモリ',
    'nav.projects': 'プロジェクト',
    'nav.agents': 'エージェント',
    'nav.settings': '設定',
    'nav.dashboard': 'ダッシュボード',
    'nav.dashboard.description': 'アプリランチャーを開く',
    'nav.memory.browse': '閲覧',
    'nav.memory.browse.description': '保存したメモリを見る',
    'nav.memory.search': '検索',
    'nav.memory.search.description': '保存したコンテキストを探す',
    'nav.memory.graph': 'グラフ',
    'nav.memory.graph.description': 'つながりを探索',
    'nav.projects.list': '一覧',
    'nav.projects.list.description': 'プロジェクトを閲覧',
    'nav.projects.board': 'ボード',
    'nav.projects.board.description': 'ステータスごとに作業を管理',
    'nav.projects.roadmap': 'ロードマップ',
    'nav.projects.roadmap.description': 'タイムラインで計画',
    'nav.projects.lessons': 'ナレッジ',
    'nav.projects.lessons.description': '学習したパターンを確認',
    'nav.projects.library': 'ライブラリ',
    'nav.projects.library.description': 'ビジュアルアセットを閲覧',
    'nav.agents.agents': 'エージェント',
    'nav.agents.agents.description': 'エージェントを設定',
    'nav.agents.sessions': 'セッション',
    'nav.agents.sessions.description': 'アクティビティを確認',
    'nav.agents.usage': '使用量',
    'nav.agents.usage.description': '使用状況を確認',
    'nav.settings.llm': 'LLM',
    'nav.settings.llm.description': 'モデル設定',
    'nav.settings.forecasts': '予測',
    'nav.settings.forecasts.description': '使用量を予測',
    'nav.settings.environment': '環境',
    'nav.settings.environment.description': '実行時変数',
    'nav.settings.resources': 'リソース',
    'nav.settings.resources.description': '接続済みリソース',
    'nav.settings.workflows': 'ワークフロー',
    'nav.settings.workflows.description': '自動化されたルーチン',
    'header.openNavigation': 'ナビゲーションメニューを開く',
    'header.services': 'OpenMemory サービス',
    'header.chooseWorkspace': '続行するワークスペースを選択',
    'header.navigation': 'ナビゲーション',
    'header.console': 'コンソール',
    'header.overview': '概要',
    'header.switchToLight': 'ライトモードに切り替え',
    'header.switchToDark': 'ダークモードに切り替え',
    'header.preferences': '表示と言語の設定を開く',
    'settings.appearance': '外観',
    'settings.theme': 'テーマ',
    'settings.theme.light': 'ライト',
    'settings.theme.dark': 'ダーク',
    'settings.theme.system': 'システム',
    'settings.language': '言語',
    'language.english': '英語',
    'language.japanese': '日本語',
    'dashboard.eyebrow': 'ワークスペース / アプリランチャー',
    'dashboard.description': 'AIメモリを運用するワークスペースです。アプリを選んでコンテキストを閲覧し、エージェントを連携させ、プロジェクトの知識を育てます。',
    'dashboard.appsAvailable': '利用可能なアプリ {count}個',
    'page.projects': 'プロジェクト',
    'page.agents': 'エージェント',
    'page.sessions': 'セッション',
    'page.agentUsage': 'エージェント使用量',
    'page.memory': 'メモリ',
    'page.search': '検索',
    'page.settings': '設定',
    'page.environment': '環境',
    'page.resources': 'リソース',
    'page.workflows': 'ワークフロー',
    'page.forecasts': '予測',
    'page.lessons': 'ナレッジ',
    'page.library': 'ライブラリ',
    'page.roadmap': 'ロードマップ',
    'page.taskDetail': 'タスク詳細',
    'projects.refresh': '更新',
    'projects.project': 'プロジェクト',
    'projects.allProjects': 'すべてのプロジェクト',
    'projects.searchBoard': 'タスクとルーチンを検索…',
    'projects.task': 'タスク',
    'projects.noProjects': 'プロジェクトはまだありません。',
    'projects.createHint': '「+ プロジェクト」をクリックして作成します。',
    'projects.newProject': '新しいプロジェクト',
    'projects.newTask': '新しいタスク',
    'projects.cancel': 'キャンセル',
    'projects.close': '閉じる',
    'status.scheduled': '予定済み',
    'status.todo': '未着手',
    'status.in_progress': '進行中',
    'status.done': '完了',
    'status.cancelled': 'キャンセル',
  },
};

interface I18nContextValue {
  language: Language;
  setLanguage: (language: Language) => void;
  t: (key: string, params?: MessageParams) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

function interpolate(message: string, params?: MessageParams): string {
  if (!params) return message;
  return Object.entries(params).reduce(
    (result, [key, value]) => result.replaceAll(`{${key}}`, String(value)),
    message,
  );
}

export function LanguageProvider({ children }: { children: React.ReactNode }) {
  const language = useSyncExternalStore<Language>(subscribeToLanguage, getStoredLanguage, getServerLanguage);

  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);

  const setLanguage = useCallback((nextLanguage: Language) => {
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, nextLanguage);
    window.dispatchEvent(new Event('openmemory-language-change'));
  }, []);

  const t = useCallback((key: string, params?: MessageParams) => {
    const message = MESSAGES[language][key] ?? MESSAGES.en[key] ?? key;
    return interpolate(message, params);
  }, [language]);

  const value = useMemo(() => ({ language, setLanguage, t }), [language, setLanguage, t]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const context = useContext(I18nContext);
  if (!context) throw new Error('useI18n must be used inside LanguageProvider');
  return context;
}

export function I18nText({ id, params }: { id: string; params?: MessageParams }) {
  const { t } = useI18n();
  return <>{t(id, params)}</>;
}

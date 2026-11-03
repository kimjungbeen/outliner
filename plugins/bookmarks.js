// 북마크 찾기 (bookmarks) — 모든 PDF · 이미지 · 오디오 · 영상의 북마크를 이름 · 파일 이름으로 찾아 열기 (고른 글자가 있으면 그 글자로)
import { command } from './_kit.js';

export default (api) => command(api, { name: 'bookmarks', label: '북마크 찾기 (모든 PDF · 이미지 · 오디오 · 영상의 북마크를 이름으로 찾아 열기)', preload: false, make: (api) => ({ bookmarks: (t) => api.files.findBookmarks(t) }) }); // 부를 때 고른 글자로 바로 찾아요

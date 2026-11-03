@echo off
chcp 65001 >nul
setlocal
rem Outliner 실행 파일 - 탐색기에서 더블클릭하면 전용 창으로 열려요.
rem 처음 실행할 때는 .venv(이 폴더 안 전용 파이썬 환경)를 만들고 필요한 패키지를 내려받아요.
rem requirements.txt가 바뀌면 다음 실행 때 알아서 다시 설치해요.
rem 다시 설치하고 싶으면 .venv 폴더를 지우고 실행하면 돼요.

cd /d "%~dp0"
set "VENV=%~dp0.venv"
set "VPY=%VENV%\Scripts\python.exe"
set "STAMP=%VENV%\.installed"

rem 지난번 준비가 중간에 실패해 pip 없는 .venv가 남아 있으면 지우고 새로 만들어요
if exist "%VPY%" "%VPY%" -m pip --version >nul 2>&1 || rmdir /s /q "%VENV%"

rem 1) 파이썬 3.9 이상 찾기 (py 런처 먼저, 그다음 python)
rem    python.exe가 Microsoft Store 바로가기 껍데기일 수 있어서 실제로 돌려 봐요
set "PY="
py -3 -c "import sys, pyexpat, ensurepip, venv; sys.exit(0 if sys.version_info >= (3, 9) else 1)" >nul 2>&1 && set "PY=py -3"
if not defined PY python -c "import sys, pyexpat, ensurepip, venv; sys.exit(0 if sys.version_info >= (3, 9) else 1)" >nul 2>&1 && set "PY=python"
if not defined PY python3 -c "import sys, pyexpat, ensurepip, venv; sys.exit(0 if sys.version_info >= (3, 9) else 1)" >nul 2>&1 && set "PY=python3"
if defined PY goto have_python
echo 파이썬 3을 찾지 못했어요.
echo   https://www.python.org/downloads/ 에서 설치해 주세요.
echo   설치할 때 "Add python.exe to PATH" 를 꼭 체크해 주세요.
start "" "https://www.python.org/downloads/windows/"
set "MSG=파이썬을 설치한 뒤 이 파일을 다시 실행해 주세요."
goto fail

:have_python
rem 2) 처음이면(또는 requirements.txt가 바뀌었으면) 전용 환경 만들고 패키지 내려받기
set "REQ_HASH="
for /f "delims=" %%h in ('%PY% -c "import hashlib; print(hashlib.sha1(open('requirements.txt','rb').read()).hexdigest())"') do set "REQ_HASH=%%h"
set "OLD_HASH="
if exist "%STAMP%" set /p OLD_HASH=<"%STAMP%"
if exist "%VPY%" if "%OLD_HASH%"=="%REQ_HASH%" goto run

echo ▶ 처음 실행 준비 중이에요 - 한 번만, 1~2분 걸려요
for /f "delims=" %%v in ('%PY% --version 2^>^&1') do echo   파이썬: %PY% - %%v
if exist "%VPY%" goto venv_ready
%PY% -m venv "%VENV%"
if errorlevel 1 (
  rmdir /s /q "%VENV%" 2>nul
  set "MSG=전용 파이썬 환경 .venv 를 만들지 못했어요."
  goto fail
)
:venv_ready
echo ▶ pip 업데이트
"%VPY%" -m pip install --upgrade pip --disable-pip-version-check -q
if errorlevel 1 (
  set "MSG=pip를 준비하지 못했어요. 인터넷 연결을 확인해 주세요."
  goto fail
)
echo ▶ 필요한 패키지 내려받기 - requirements.txt
"%VPY%" -m pip install -r requirements.txt --disable-pip-version-check -q
if errorlevel 1 (
  set "MSG=패키지를 내려받지 못했어요. 인터넷 연결을 확인해 주세요."
  goto fail
)
> "%STAMP%" echo %REQ_HASH%
echo ✅ 준비 끝
echo.

:run
rem 3) 실행 (창을 모두 닫으면 서버도 꺼지고 이 창도 끝나요)
echo ▶ Outliner를 여는 중… 이 창은 앱이 켜져 있는 동안 열어 두세요.
"%VPY%" src\launcher.py %*
if errorlevel 1 (
  set "MSG=앱이 오류로 끝났어요. 위 메시지를 확인해 주세요."
  goto fail
)
exit /b 0

:fail
echo.
echo ⚠️  %MSG%
echo.
pause
exit /b 1

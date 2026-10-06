[실행 방법]

1. index.html, style.css, script.js, rat.fbx를 같은 폴더에 둡니다.
2. 해당 폴더에서 로컬 서버를 실행합니다.

Python이 있다면:
  python -m http.server 8000

3. 브라우저에서 아래 주소를 엽니다.
  http://localhost:8000/

[조작]
W A S D : 이동
Shift : 달리기
Space : 점프
마우스 드래그 : 카메라 회전

[리깅/애니메이션 확인]
- 화면 왼쪽 패널에서 Animation Clips 개수 확인
- 재생할 애니메이션을 선택하고 재생/정지
- '본 구조 표시' 체크로 SkeletonHelper 표시
- '모델 축 표시' 체크로 모델의 로컬 축 표시

주의:
- FBX의 텍스처가 외부 파일로 연결되어 있었다면 해당 텍스처 파일도 같은 경로 구조가 필요할 수 있습니다.
- FBXLoader는 파일의 애니메이션 데이터를 브라우저에서 읽어 object.animations로 제공합니다.

# Nature Gateway Walk

크롬 우측 하단에 작은 자연 버튼을 띄우고, 버튼을 누르면 짧은 회복 공간으로 들어가는 프로토타입입니다.

## 사용 방법

1. Chrome에서 `chrome://extensions`를 엽니다.
2. 우측 상단의 개발자 모드를 켭니다.
3. `압축해제된 확장 프로그램을 로드`를 누릅니다.
4. 이 폴더를 선택합니다.

```txt
C:\Users\Administrator\distraction-save\nature-gateway-extension
```

## 흐름

- 우측 하단 자연 버튼 클릭
- 자연 산책 화면으로 바로 진입
- `W/A/S/D`로 천천히 이동
- 마우스로 시선 이동
- "이제 돌아가기" 버튼은 항상 표시

질문 화면에는 "자연화면 선택하기" 버튼도 들어 있습니다. 나중에 이 화면을 별도 시작 화면으로 다시 연결하거나, 여러 자연 장면을 고르는 화면으로 확장할 수 있습니다.

## 실제 자연 비디오 또는 이미지 넣기

비디오를 쓰고 싶으면 아래 경로에 파일을 넣으세요.

```txt
C:\Users\Administrator\distraction-save\nature-gateway-extension\assets\nature.mp4
```

이미지를 쓰고 싶으면 아래 경로에 파일을 넣으세요.

```txt
C:\Users\Administrator\distraction-save\nature-gateway-extension\assets\nature.jpg
```

`nature.mp4`가 있으면 비디오를 먼저 사용하고, 비디오가 없으면 `nature.jpg`를 사용합니다.

파일을 넣은 뒤에는 `chrome://extensions`에서 확장을 새로고침하고, 열려 있던 웹페이지도 새로고침하세요.

추천 비디오:

- mp4 형식
- 10초에서 60초 정도의 반복 가능한 자연 영상
- 카메라 움직임이 너무 빠르지 않은 영상
- 물가, 숲길, 바람에 흔들리는 나무처럼 천천히 움직이는 장면

추천 이미지:

- 가로형 사진
- 최소 1920x1080 이상
- 숲길, 호숫가, 산길처럼 중앙에 깊이감이 있는 사진
- 너무 밝거나 복잡하지 않은 사진

## 다음에 붙이면 좋은 것

- 물소리/바람소리 오디오 토글
- YouTube 홈에서만 자동으로 열기
- 20초, 1분, 3분 회복 시간 선택
- 여러 자연 장면 선택

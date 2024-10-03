import os

def concatenate_files(directory, output_file):
    with open(output_file, 'w') as outfile:
        for root, dirs, files in os.walk(directory):
            for file in files:
                if file.endswith(('.js', '.css', '.svg', '.txt')):
                    file_path = os.path.join(root, file)
                    with open(file_path, 'r') as infile:
                        outfile.write(infile.read())
                        outfile.write('\n')

concatenate_files('.', 'output.txt')
